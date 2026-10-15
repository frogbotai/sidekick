import type { ModelMessage } from 'ai';

import { type AgentInfo, offersTool } from '../agent/agent';
import type { PermissionSeam } from '../permission/seam';
import type { Registry } from '../registry/registry';
import type { ToolDefinition } from '../tool/tool';
import { buildRequest, TOOL_INTERRUPTED } from './request';
import { classify, MAX_RETRIES, retryDelay, sessionError } from './retry';
import {
  ascending,
  type AssistantMessage,
  type DurableEventBody,
  type IdleMessage,
  type SessionInfo,
  type SessionMessage,
  type UserPart,
} from './schema';
import { abortable, runStep } from './step';
import type { SessionList, SessionStore } from './store';
import { generateTitle, isUntitledRoot, type ModelSource, titleInput } from './title';

/** v2's prompt for a turn's last allowed step (`runner/max-steps.ts`). */
export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

export const STEP_INTERRUPTED = 'Step interrupted';

/** Time for the engine, so tests can wait without waiting. */
export interface Clock {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
}

/** One exclusive lock per name across windows, as Web Locks give; `ifAvailable` skips a held one. */
export interface SessionLocks {
  run: <T>(name: string, ifAvailable: boolean, work: () => Promise<T>) => Promise<T | undefined>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    abortable(new Promise<void>((resolve) => void setTimeout(resolve, ms)), signal),
};

/** `navigator.locks`, as the engine uses it. */
export function webLocks(manager: LockManager = navigator.locks): SessionLocks {
  return {
    run: (name, ifAvailable, work) =>
      manager.request(name, { ifAvailable }, (lock) =>
        lock ? work() : Promise.resolve(undefined),
      ),
  };
}

export interface SessionEngineOptions {
  store: SessionStore;
  models: ModelSource;
  tools: Pick<Registry<ToolDefinition>, 'list'>;
  agents: Pick<Registry<AgentInfo>, 'get'>;
  permission: PermissionSeam;
  clock?: Clock;
  locks?: SessionLocks;
  /** The agent for new sessions and for a session whose agent is gone. */
  defaultAgent?: string;
  /** The title agent's id. */
  titleAgent?: string;
  /** Called after each turn's `idle` message. */
  onIdle?: (sessionID: string) => void;
}

export interface CreateInput {
  model: string;
  agent?: string;
  parentID?: string;
  windowId?: number;
}

export interface PromptInput {
  sessionID: string;
  parts: UserPart[];
  /** Edits from this message: it and every later message are deleted first. */
  from?: string;
  /** Switches the session's model first, writing `model-switched`. */
  model?: string;
  agent?: string;
}

export interface Queued {
  messageID: string;
  parts: UserPart[];
}

export interface SessionEngine {
  create: (input: CreateInput) => Promise<SessionInfo>;
  /** Queues a message; it runs once the session's current turn, in any window, ends. */
  prompt: (input: PromptInput) => Promise<{ messageID: string; done: Promise<void> }>;
  abort: (sessionID: string) => void;
  /** Fails tools a closed panel left `streaming` or `running`, and ends their turns `interrupted`. */
  sweep: () => Promise<void>;
  queued: (sessionID: string) => Queued[];
  busy: (sessionID: string) => boolean;
  log: SessionStore['log'];
  messages: SessionStore['messages'];
  sessions: SessionList;
}

type Outcome = IdleMessage['outcome'];

interface Entry extends PromptInput {
  messageID: string;
}

const lockName = (sessionID: string) => `sidekick.session.${sessionID}`;

function unsettled(message: SessionMessage): message is AssistantMessage {
  return (
    message.type === 'assistant' &&
    (message.time.completed === undefined ||
      message.content.some(
        (part) =>
          part.type === 'tool' &&
          (part.state.status === 'streaming' || part.state.status === 'running'),
      ))
  );
}

/**
 * The agent loop, after OpenCode v2's runner. It uses no extension API, so it can move to the worker
 * later. Each step is one model call; the engine runs its tool calls through the registry,
 * persists them, reloads history and steps again while any tool ran.
 */
export function createSessionEngine(options: SessionEngineOptions): SessionEngine {
  const { store, models, tools, agents, permission } = options;
  const clock = options.clock ?? realClock;
  const locks = options.locks ?? webLocks();
  const defaultAgent = options.defaultAgent ?? 'build';
  const titleAgent = options.titleAgent ?? 'title';
  const waiting = new Map<string, Entry[]>();
  const controllers = new Map<string, AbortController>();
  const holding = new Set<string>();
  const deleted = new Set<string>();
  const titled = new Set<string>();

  const publish = (sessionID: string, body: DurableEventBody) => store.publish(sessionID, body);

  const id = () => ascending('msg', clock.now());

  const agentOf = (session: SessionInfo) => agents.get(session.agent) ?? agents.get(defaultAgent);

  const settle = async (sessionID: string, messages: readonly SessionMessage[]) => {
    for (const message of messages) {
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

  const step = async (
    sessionID: string,
    agent: AgentInfo,
    count: number,
    signal: AbortSignal,
  ): Promise<Outcome | 'continue'> => {
    const session = await store.sessions.get(sessionID);

    if (!session) return 'failed';

    const ref = agent.model ?? session.model;
    let messageID = id();
    let retries = 0;

    await publish(sessionID, {
      type: 'session.step.started',
      messageID,
      agent: agent.id,
      model: ref,
    });

    let model;

    try {
      model = await models.resolve(ref);
    } catch (error) {
      return fail(sessionID, messageID, error);
    }

    const limited = agent.steps !== undefined && count >= agent.steps;
    const offered = tools.list().filter((tool) => offersTool(agent, tool));

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
        messageID,
        agent,
        language: model.language,
        messages,
        tools: offered,
        ...(limited ? { toolChoice: 'none' as const } : {}),
        permission,
        signal,
      });

      if (result.aborted) return interrupt(sessionID);

      if (result.error === undefined) return limited || !result.called ? 'succeeded' : 'continue';

      const verdict = classify(result.error);

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
    const last = await store.last(sessionID);

    if (!last || last.type === 'idle') return;

    if (last.type !== 'assistant' && last.type !== 'user' && last.type !== 'synthetic') return;

    await settle(sessionID, await store.messages(sessionID));
    await publish(sessionID, { type: 'session.idle', messageID: id(), outcome: 'interrupted' });
  };

  const run = async (entry: Entry) => {
    const { sessionID } = entry;
    const session = await store.sessions.get(sessionID);

    if (!session || deleted.has(sessionID)) return;

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

  const sweepOne = async (session: SessionInfo) => {
    const last = await store.last(session.id);

    if (!last || last.type === 'idle' || controllers.has(session.id)) return;

    if (last.type !== 'assistant' && last.type !== 'user' && last.type !== 'synthetic') return;

    await locks.run(lockName(session.id), true, () => recover(session.id));
  };

  return {
    create: async ({ model, agent, parentID, windowId }) => {
      const now = clock.now();

      const info: SessionInfo = {
        id: ascending('ses', now),
        agent: agent ?? defaultAgent,
        model,
        ...(parentID ? { parentID } : {}),
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

      const entry: Entry = { ...input, messageID: id() };
      const queue = waiting.get(input.sessionID) ?? [];

      queue.push(entry);
      waiting.set(input.sessionID, queue);

      const done = locks
        .run(lockName(input.sessionID), false, async () => {
          queue.splice(queue.indexOf(entry), 1);
          holding.add(input.sessionID);

          try {
            await run(entry);
          } finally {
            holding.delete(input.sessionID);
          }
        })
        .then(
          () => undefined,
          () => undefined,
        );

      return { messageID: entry.messageID, done };
    },
    abort: (sessionID) => controllers.get(sessionID)?.abort(),
    sweep: async () => {
      for (const session of await store.all()) await sweepOne(session);
    },
    queued: (sessionID) =>
      (waiting.get(sessionID) ?? []).map(({ messageID, parts }) => ({ messageID, parts })),
    busy: (sessionID) => controllers.has(sessionID),
    log: store.log,
    messages: store.messages,
    sessions: {
      ...store.sessions,
      delete: async (sessionID) => {
        deleted.add(sessionID);
        waiting.delete(sessionID);
        controllers.get(sessionID)?.abort();

        const remove = async () => {
          await store.sessions.delete(sessionID);

          return true;
        };

        if (holding.has(sessionID)) {
          await locks.run(lockName(sessionID), false, remove);

          return;
        }

        if (!(await locks.run(lockName(sessionID), true, remove))) await remove();
      },
    },
  };
}
