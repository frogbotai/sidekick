import type { ModelMessage } from 'ai';

import type { AgentInfo } from '../agent/agent';
import type { PermissionSeam } from '../permission/engine';
import { BUILD_MODE, type PermissionMode } from '../permission/modes';
import { permissionModes } from '../registry';
import type { Registry } from '../registry/registry';
import type { ToolDefinition } from '../tool/tool';
import {
  ceiling,
  COMPACTION_DEFAULTS,
  COMPACTION_INTERRUPTED,
  type CompactionSettings,
  due,
} from './compaction';
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
  webLocks,
} from './queue';
import { buildRequest, TOOL_INTERRUPTED } from './request';
import { classify, MAX_RETRIES, retryDelay, sessionError } from './retry';
import {
  ascending,
  type CompactionMessage,
  type DurableEventBody,
  type IdleMessage,
  type SessionInfo,
  type SessionMessage,
  type UserPart,
} from './schema';
import { modelOf, running, stranded, unsettled } from './state';
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
import { generateTitle, isUntitledRoot, type ModelSource, titleInput } from './title';

export const STEP_INTERRUPTED = 'Step interrupted';

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
  /** Compacts the session now, or after its running turn, in any window, ends. */
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
  const deleted = new Set<string>();
  const titled = new Set<string>();

  const publish = (sessionID: string, body: DurableEventBody) => store.publish(sessionID, body);

  const id = () => ascending('msg', clock.now());

  const stored = async (sessionID: string, messageID: string) =>
    (await store.messages(sessionID)).some((message) => message.id === messageID);

  const agentOf = (session: SessionInfo) => agents.get(session.agent) ?? agents.get(defaultAgent);

  const settle = async (sessionID: string, messages: readonly SessionMessage[]) => {
    for (const message of messages) {
      if (running(message)) {
        await publish(sessionID, {
          type: 'session.compaction.failed',
          messageID: message.id,
          error: { type: 'aborted', message: COMPACTION_INTERRUPTED },
        });
      }

      if (!unsettled(message)) continue;

      for (const part of message.content) {
        if (part.type !== 'tool') continue;

        if (part.state.status !== 'streaming' && part.state.status !== 'running') continue;

        await publish(sessionID, {
          type: 'session.tool.failed',
          messageID: message.id,
          callID: part.id,
          error: { message: TOOL_INTERRUPTED, code: 'cancelled' },
        });
      }

      if (message.time.completed === undefined) {
        await publish(sessionID, {
          type: 'session.step.failed',
          messageID: message.id,
          error: { type: 'aborted', message: STEP_INTERRUPTED },
        });
      }
    }
  };

  const interrupt = async (sessionID: string): Promise<Outcome> => {
    await settle(sessionID, await store.messages(sessionID));

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

      const messages: ModelMessage[] = limited
        ? [...request, { role: 'assistant', content: MAX_STEPS_PROMPT }]
        : request;

      const result = await runStep({
        store,
        sessionID,
        rootID: session.parentID ?? sessionID,
        messageID,
        agent,
        language: model.language,
        messages,
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

  const turn = async (sessionID: string, signal: AbortSignal): Promise<Outcome> => {
    for (let count = 1; ; count++) {
      if (signal.aborted) return interrupt(sessionID);

      const session = await store.sessions.get(sessionID);
      const agent = session && agentOf(session);

      if (!agent) return 'failed';

      const outcome = await step(sessionID, agent, count, signal);

      if (outcome !== 'continue') return outcome;
    }
  };

  const title = async (session: SessionInfo, parts: readonly UserPart[]) => {
    const agent = agents.get(titleAgent);

    if (!agent || titled.has(session.id) || !isUntitledRoot(session)) return;

    const users = (await store.messages(session.id)).filter(({ type }) => type === 'user');

    if (users.length !== 1) return;

    titled.add(session.id);
    void generateTitle({ store, models, agent, session, text: titleInput(parts) });
  };

  const recover = async (sessionID: string) => {
    if (!stranded(await store.last(sessionID))) return;

    await settle(sessionID, await store.messages(sessionID));
    await publish(sessionID, { type: 'session.idle', messageID: id(), outcome: 'interrupted' });
  };

  const compactNow = async ({ sessionID, messageID }: CompactEntry) => {
    const session = await store.sessions.get(sessionID);
    const agent = session && agentOf(session);

    if (!session || !agent || deleted.has(sessionID)) return;

    await recover(sessionID);

    const ref = modelOf(agent, session);
    const controller = new AbortController();

    controllers.set(sessionID, controller);

    try {
      const model = { ...(await models.resolve(ref)), ref };

      results.set(
        messageID,
        manualResult(
          await summarize(
            sessionID,
            agent,
            session.mode ?? BUILD_MODE,
            model,
            'manual',
            controller.signal,
          ),
        ),
      );
    } catch (error) {
      results.set(messageID, { status: 'failed', error: sessionError(error) });
    } finally {
      controllers.delete(sessionID);
    }
  };

  const runPrompt = async (entry: PromptEntry) => {
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

    await publish(sessionID, {
      type: 'session.prompted',
      messageID: entry.messageID,
      parts: entry.parts,
    });

    await title(session, entry.parts);

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
    compact: async ({ sessionID }) => {
      if (!(await store.sessions.get(sessionID))) throw new Error(`No session ${sessionID}`);

      const messageID = id();

      await (
        await queue.admit({ kind: 'compact', sessionID, messageID })
      ).done;

      const result = results.get(messageID);

      results.delete(messageID);

      return (
        result ?? { status: 'failed', error: { type: 'aborted', message: COMPACTION_INTERRUPTED } }
      );
    },
    abort: (sessionID) => controllers.get(sessionID)?.abort(),
    cancel: queue.cancel,
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
