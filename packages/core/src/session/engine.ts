import type { AgentInfo } from '../agent/agent';
import type { PermissionSeam } from '../permission/engine';
import { BUILD_MODE, type PermissionMode } from '../permission/modes';
import { permissionModes } from '../registry';
import type { Registry } from '../registry/registry';
import type { ToolDefinition } from '../tool/tool';
import { markRequest } from './cache';
import { ceiling, COMPACTION_DEFAULTS, type CompactionSettings, due } from './compaction';
import { COMPACT_INTERRUPTED, createInbox } from './inbox';
import { modeReminder, offeredTools, promptChanges } from './mode';
import {
  type Admitted,
  type CompactEntry,
  createSessionQueue,
  type Entry,
  lockName,
  type PromptEntry,
  type PromptInput,
  type Queued,
  type SessionLocks,
  type SteerInput,
  webLocks,
} from './queue';
import { buildRequest } from './request';
import { classify, MAX_RETRIES, retryDelay, sessionError } from './retry';
import {
  ascending,
  type CompactionMessage,
  type DurableEventBody,
  type IdleMessage,
  type SessionInfo,
} from './schema';
import { settle } from './settle';
import { modelOf, stranded } from './state';
import { type Clock, MAX_STEPS_PROMPT, realClock, runStep } from './step';

export type { Clock } from './step';
export { MAX_STEPS_PROMPT, realClock } from './step';
import type { SessionList, SessionStore } from './store';
import {
  compact as runCompaction,
  type CompactOutcome,
  type CompactResult,
  manualResult,
} from './summarize';
import { type ModelSource, titleFirst } from './title';

export { STEP_INTERRUPTED } from './settle';

export interface SessionEngineOptions {
  store: SessionStore;
  models: ModelSource;
  tools: Pick<Registry<ToolDefinition>, 'list'>;
  agents: Pick<Registry<AgentInfo>, 'get'>;
  permission: PermissionSeam;
  /** Permission modes, for each chat's tools and reminders; the `permissionModes` registry by default. */
  modes?: Pick<Registry<PermissionMode>, 'get' | 'list'>;
  clock?: Clock;
  locks?: SessionLocks;
  /** The agent for new sessions and for a session whose agent is gone. */
  defaultAgent?: string;
  /** The title agent's id. */
  titleAgent?: string;
  /** The compaction agent's id, whose prompt the summary request ends with. */
  compactionAgent?: string;
  /** When and how much to compact; on with a 15k verbatim tail by default. */
  compaction?: CompactionSettings;
  /** Called after each turn's `idle` message. */
  onIdle?: (sessionID: string) => void;
}

/** A new session; a child (`parentID`) takes its parent's mode unless `mode` is given. */
export interface CreateInput {
  model: string;
  agent?: string;
  mode?: string;
  parentID?: string;
  title?: string;
  windowId?: number;
}

export interface SessionEngine {
  create: (input: CreateInput) => Promise<SessionInfo>;
  /** Queues a message; it runs once the session's current turn, in any window, ends. */
  prompt: (input: PromptInput) => Promise<Admitted>;
  /**
   * Hands a message to this window's running turn, which takes it at its next step boundary; with
   * no turn running here, it is `prompt`. A steer the turn never reached starts the next turn.
   */
  steer: (input: SteerInput) => Promise<void>;
  /**
   * Compacts the session now. During this window's turn it runs at the next step boundary and the
   * turn goes on; during another window's, it waits for that turn to end.
   */
  compact: (input: { sessionID: string }) => Promise<CompactResult>;
  abort: (sessionID: string) => void;
  /** Takes back a queued message before it runs; false once it has started. */
  cancel: (sessionID: string, messageID: string) => boolean;
  /** Fails tools a closed panel left `streaming` or `running`, and ends their turns `interrupted`. */
  sweep: () => Promise<void>;
  queued: (sessionID: string) => Queued[];
  busy: (sessionID: string) => boolean;
  log: SessionStore['log'];
  head: SessionStore['head'];
  watch: SessionStore['watch'];
  messages: SessionStore['messages'];
  sessions: SessionList;
}

type Outcome = IdleMessage['outcome'];

type Resolved = Awaited<ReturnType<ModelSource['resolve']>>;

/**
 * The agent loop, after OpenCode v2's runner. It uses no extension API, so it can move to the worker
 * later. Each step is one model call; the engine runs its tool calls through the registry,
 * persists them, reloads history and steps again while any tool ran.
 */
export function createSessionEngine(options: SessionEngineOptions): SessionEngine {
  const { store, models, tools, agents, permission } = options;
  const modes = options.modes ?? permissionModes;
  const clock = options.clock ?? realClock;
  const locks = options.locks ?? webLocks();
  const defaultAgent = options.defaultAgent ?? 'build';
  const titleAgent = options.titleAgent ?? 'title';
  const compactionAgent = options.compactionAgent ?? 'compaction';
  const settings = { ...COMPACTION_DEFAULTS, ...options.compaction };
  const results = new Map<string, CompactResult>();
  const controllers = new Map<string, AbortController>();
  const inbox = createInbox();
  const deleted = new Set<string>();
  const titled = new Set<string>();

  const publish = (sessionID: string, body: DurableEventBody) => store.publish(sessionID, body);

  const id = () => ascending('msg', clock.now());

  const stored = async (sessionID: string, messageID: string) =>
    (await store.messages(sessionID)).some((message) => message.id === messageID);

  const agentOf = (session: SessionInfo) => agents.get(session.agent) ?? agents.get(defaultAgent);

  const interrupt = async (sessionID: string): Promise<Outcome> => {
    await settle(store, sessionID);

    return 'interrupted';
  };

  const fail = async (sessionID: string, messageID: string, error: unknown): Promise<Outcome> => {
    await publish(sessionID, {
      type: 'session.step.failed',
      messageID,
      error: sessionError(error),
    });

    return 'failed';
  };

  const offeredTo = (agent: AgentInfo, mode: string) =>
    offeredTools(tools, modes, agent, mode).map((tool) =>
      tool.describe ? { ...tool, description: tool.describe(agent) } : tool,
    );

  const remind = async (sessionID: string, mode: string) => {
    const text = modeReminder(await store.messages(sessionID), modes, mode);

    if (text) await publish(sessionID, { type: 'session.synthetic', messageID: id(), text });
  };

  const summarize = (
    sessionID: string,
    agent: AgentInfo,
    mode: string,
    model: Resolved & { ref: string },
    reason: CompactionMessage['reason'],
    signal: AbortSignal,
    overflow = false,
  ): Promise<CompactOutcome> => {
    const prompt = agents.get(compactionAgent)?.system;

    return runCompaction({
      store,
      sessionID,
      messageID: id(),
      reason,
      model,
      ...(prompt ? { prompt } : {}),
      ...(agent.system ? { system: agent.system } : {}),
      tools: offeredTo(agent, mode),
      keep: settings.keep,
      ...(settings.buffer === undefined ? {} : { buffer: settings.buffer }),
      overflow,
      signal,
      clock,
    });
  };

  const step = async (
    sessionID: string,
    agent: AgentInfo,
    count: number,
    signal: AbortSignal,
  ): Promise<Outcome | 'continue'> => {
    const session = await store.sessions.get(sessionID);

    if (!session) return 'failed';

    const ref = modelOf(agent, session);
    let messageID = id();
    let retries = 0;
    let recovered = false;

    const started = () =>
      publish(sessionID, { type: 'session.step.started', messageID, agent: agent.id, model: ref });

    let model: Resolved & { ref: string };

    try {
      model = { ...(await models.resolve(ref)), ref };
    } catch (error) {
      await started();

      return fail(sessionID, messageID, error);
    }

    const limited = agent.steps !== undefined && count >= agent.steps;
    const mode = session.mode ?? BUILD_MODE;
    const offered = offeredTo(agent, mode);

    const full =
      settings.auto &&
      due({
        messages: await store.messages(sessionID),
        model: ref,
        reasoning: model.reasoning,
        ...(agent.system ? { system: agent.system } : {}),
        tools: offered,
        ceiling: ceiling(model.limit, settings.buffer),
      });

    if (full) {
      const outcome = await summarize(sessionID, agent, mode, model, 'auto', signal);

      if (outcome.status === 'aborted') return interrupt(sessionID);

      if (outcome.status === 'failed') return 'failed';

      await remind(sessionID, mode);
    }

    await started();

    for (;;) {
      const request = buildRequest({
        messages: await store.messages(sessionID),
        reasoning: model.reasoning,
      });

      const marked = markRequest({
        route: model.cache,
        ...(agent.system ? { system: agent.system } : {}),
        messages: limited
          ? [...request, { role: 'assistant', content: MAX_STEPS_PROMPT }]
          : request,
        sessionID,
      });

      const result = await runStep({
        store,
        sessionID,
        rootID: session.parentID ?? sessionID,
        messageID,
        agent,
        language: model.language,
        ...marked,
        tools: offered,
        ...(limited ? { toolChoice: 'none' as const } : {}),
        permission,
        mode,
        sites: session.sites ?? [],
        signal,
      });

      if (result.aborted) return interrupt(sessionID);

      if (result.error === undefined) return limited || !result.called ? 'succeeded' : 'continue';

      const verdict = classify(result.error);

      if (verdict === 'overflow' && settings.auto && !recovered) {
        recovered = true;

        await publish(sessionID, {
          type: 'session.step.failed',
          messageID,
          error: sessionError(result.error, verdict),
        });

        const outcome = await summarize(sessionID, agent, mode, model, 'auto', signal, true);

        if (outcome.status === 'aborted') return interrupt(sessionID);

        if (outcome.status !== 'completed') return 'failed';

        await remind(sessionID, mode);
        messageID = id();
        retries = 0;
        await started();
        continue;
      }

      if (verdict !== 'retry' || retries >= MAX_RETRIES) {
        await publish(sessionID, {
          type: 'session.step.failed',
          messageID,
          error: sessionError(result.error, verdict),
        });

        return 'failed';
      }

      retries++;

      const delay = retryDelay(retries, result.error, clock.random, clock.now());
      const error = sessionError(result.error, verdict);

      if (result.started) {
        await publish(sessionID, { type: 'session.step.failed', messageID, error });
        messageID = id();

        await publish(sessionID, {
          type: 'session.step.started',
          messageID,
          agent: agent.id,
          model: ref,
        });
      }

      await publish(sessionID, {
        type: 'session.retry.scheduled',
        messageID,
        attempt: retries,
        at: clock.now() + delay,
        error,
      });

      try {
        await clock.sleep(delay, signal);
      } catch {
        return interrupt(sessionID);
      }

      await publish(sessionID, {
        type: 'session.step.started',
        messageID,
        agent: agent.id,
        model: ref,
      });
    }
  };

  const manual = async (
    session: SessionInfo,
    agent: AgentInfo,
    signal: AbortSignal,
  ): Promise<CompactOutcome> => {
    const ref = modelOf(agent, session);

    try {
      const model = { ...(await models.resolve(ref)), ref };

      return await summarize(
        session.id,
        agent,
        session.mode ?? BUILD_MODE,
        model,
        'manual',
        signal,
      );
    } catch (error) {
      return { status: 'failed', error: sessionError(error) };
    }
  };

  const write = async (sessionID: string, entries: readonly PromptEntry[]) => {
    for (const { messageID, parts } of entries) {
      await publish(sessionID, { type: 'session.prompted', messageID, parts });
    }
  };

  const boundary = async (
    session: SessionInfo,
    agent: AgentInfo,
    signal: AbortSignal,
  ): Promise<Outcome | boolean> => {
    if (signal.aborted) return interrupt(session.id);

    const { compacted, steers } = await inbox.take(session.id, () =>
      manual(session, agent, signal),
    );

    if (compacted?.status === 'aborted') return interrupt(session.id);

    if (compacted?.status === 'failed') return 'failed';

    if (compacted?.status === 'completed') await remind(session.id, session.mode ?? BUILD_MODE);

    await write(session.id, steers);

    return steers.length > 0;
  };

  const turn = async (sessionID: string, signal: AbortSignal): Promise<Outcome> => {
    for (let count = 1; ; count++) {
      if (signal.aborted) return interrupt(sessionID);

      const session = await store.sessions.get(sessionID);
      const agent = session && agentOf(session);

      if (!session || !agent) return 'failed';

      const outcome = await step(sessionID, agent, count, signal);

      if (outcome !== 'continue' && outcome !== 'succeeded') return outcome;

      const steered = await boundary(session, agent, signal);

      if (typeof steered === 'string') return steered;

      if (steered) count = 0;
      else if (outcome === 'succeeded') return outcome;
    }
  };

  const recover = async (sessionID: string) => {
    if (!stranded(await store.last(sessionID))) return;

    await settle(store, sessionID);
    await publish(sessionID, { type: 'session.idle', messageID: id(), outcome: 'interrupted' });
  };

  const compactNow = async ({ sessionID, messageID }: CompactEntry) => {
    const session = await store.sessions.get(sessionID);
    const agent = session && agentOf(session);

    if (!session || !agent || deleted.has(sessionID)) return;

    await recover(sessionID);

    const controller = new AbortController();

    controllers.set(sessionID, controller);

    try {
      results.set(messageID, manualResult(await manual(session, agent, controller.signal)));
    } finally {
      controllers.delete(sessionID);
    }
  };

  const startTurn = async (entry: PromptEntry) => {
    const { sessionID } = entry;
    const session = await store.sessions.get(sessionID);

    if (!session || deleted.has(sessionID)) return;

    if (!entry.from && (await stored(sessionID, entry.messageID))) return;

    await recover(sessionID);

    if (entry.from) await publish(sessionID, { type: 'session.truncated', messageID: entry.from });

    if (entry.agent && entry.agent !== session.agent) {
      await publish(sessionID, {
        type: 'session.agent.selected',
        messageID: id(),
        agent: entry.agent,
      });
    }

    if (entry.model && entry.model !== session.model) {
      await publish(sessionID, {
        type: 'session.model.selected',
        messageID: id(),
        model: entry.model,
      });
    }

    const changes = promptChanges(session, entry, await store.messages(sessionID), modes, id);

    for (const body of changes) await publish(sessionID, body);

    await write(sessionID, [entry, ...inbox.followers(entry.messageID)]);

    await titleFirst(
      { store, models, agent: agents.get(titleAgent), session, titled },
      entry.parts,
    );

    const controller = new AbortController();

    controllers.set(sessionID, controller);

    try {
      let outcome: Outcome;

      try {
        outcome = await turn(sessionID, controller.signal);
      } catch {
        outcome = controller.signal.aborted ? await interrupt(sessionID) : 'failed';
      } finally {
        controllers.delete(sessionID);
      }

      await publish(sessionID, { type: 'session.idle', messageID: id(), outcome });
    } finally {
      options.onIdle?.(sessionID);
    }
  };

  const runPrompt = async (entry: PromptEntry) => {
    inbox.begin(entry.sessionID);

    try {
      await startTurn(entry);
    } finally {
      inbox.end(entry.sessionID, {
        compact: () => compactLater(entry.sessionID),
        prompt: (first) => void queue.admit(first),
      });
    }
  };

  const compactLater = async (sessionID: string): Promise<CompactResult> => {
    const messageID = id();

    await (
      await queue.admit({ kind: 'compact', sessionID, messageID })
    ).done;

    const result = results.get(messageID) ?? COMPACT_INTERRUPTED;

    results.delete(messageID);

    return result;
  };

  const run = (entry: Entry) => (entry.kind === 'compact' ? compactNow(entry) : runPrompt(entry));

  const queue = createSessionQueue({ locks, run, stored });

  const sweepOne = async (session: SessionInfo) => {
    const last = await store.last(session.id);

    if (!stranded(last) || controllers.has(session.id)) return;

    await locks.run(lockName(session.id), true, () => recover(session.id));
  };

  const deleteSession = async (sessionID: string): Promise<void> => {
    deleted.add(sessionID);
    queue.drop(sessionID);
    inbox.drop(sessionID);
    controllers.get(sessionID)?.abort();

    for (const child of await store.sessions.list({ parentID: sessionID })) {
      await deleteSession(child.id);
    }

    const remove = async () => {
      await store.sessions.delete(sessionID);

      return true;
    };

    if (queue.holding(sessionID)) {
      await locks.run(lockName(sessionID), false, remove);

      return;
    }

    if (!(await locks.run(lockName(sessionID), true, remove))) await remove();
  };

  return {
    create: async ({ model, agent, mode, parentID, title, windowId }) => {
      const parent = parentID ? await store.sessions.get(parentID) : undefined;
      const chosen = mode ?? parent?.mode;
      const now = clock.now();

      const info: SessionInfo = {
        id: ascending('ses', now),
        agent: agent ?? defaultAgent,
        model,
        ...(chosen ? { mode: chosen } : {}),
        ...(parentID ? { parentID } : {}),
        ...(title ? { title } : {}),
        ...(windowId === undefined ? {} : { windowId }),
        created: now,
        updated: now,
      };

      await publish(info.id, { type: 'session.created', info });

      return info;
    },
    prompt: async (input) => {
      if (!(await store.sessions.get(input.sessionID))) {
        throw new Error(`No session ${input.sessionID}`);
      }

      return queue.admit({ ...input, kind: 'prompt', messageID: input.messageID ?? id() });
    },
    steer: async (input) => {
      if (!(await store.sessions.get(input.sessionID))) {
        throw new Error(`No session ${input.sessionID}`);
      }

      if (inbox.turning(input.sessionID)) inbox.steer({ ...input, kind: 'prompt' });
      else await queue.admit({ ...input, kind: 'prompt' });
    },
    compact: async ({ sessionID }) => {
      if (!(await store.sessions.get(sessionID))) throw new Error(`No session ${sessionID}`);

      return inbox.turning(sessionID) ? inbox.compact(sessionID) : compactLater(sessionID);
    },
    abort: (sessionID) => controllers.get(sessionID)?.abort(),
    cancel: (sessionID, messageID) => {
      inbox.cancel(messageID);

      return queue.cancel(sessionID, messageID);
    },
    sweep: async () => {
      for (const session of await store.all()) await sweepOne(session);
    },
    queued: queue.queued,
    busy: (sessionID) => controllers.has(sessionID) || queue.holding(sessionID),
    log: store.log,
    head: store.head,
    watch: store.watch,
    messages: store.messages,
    sessions: {
      ...store.sessions,
      delete: deleteSession,
    },
  };
}
