import type {
  Admitted,
  CreateInput,
  DurableEventBody,
  EphemeralEventBody,
  LogEvent,
  PromptInput,
  Queued,
  SessionEngine,
  SessionInfo,
  SessionMessage,
} from '@frogbotai/sidekick-core';

function isEphemeral(body: DurableEventBody | EphemeralEventBody): body is EphemeralEventBody {
  return body.type.endsWith('.delta') || body.type === 'session.deleted';
}

/** An engine stand-in: `play` feeds the live log, and every call is recorded. */
export function fakeEngine(sessionID = 'ses_1') {
  const calls: string[] = [];
  const prompts: PromptInput[] = [];
  const creates: CreateInput[] = [];
  const listeners = new Set<(event: LogEvent) => void>();
  const queue: Queued[] = [];
  const sessions = new Map<string, SessionInfo>();
  let seq = 0;
  let running = false;

  const info = (id: string): SessionInfo => ({
    id,
    agent: 'build',
    model: 'openai/gpt-5',
    created: 1,
    updated: 1,
  });

  sessions.set(sessionID, info(sessionID));

  const deliver = (event: LogEvent) => {
    for (const listener of [...listeners]) listener(event);
  };

  const play = (...bodies: (DurableEventBody | EphemeralEventBody)[]) => {
    for (const body of bodies) {
      if (isEphemeral(body)) deliver({ sessionID, created: seq, ...body });
      else deliver({ id: `e${seq}`, sessionID, seq: ++seq, created: seq, ...body });
    }
  };

  async function* log({ signal }: { signal?: AbortSignal }): AsyncGenerator<LogEvent> {
    const events: LogEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: LogEvent) => {
      events.push(event);
      wake?.();
    };

    listeners.add(listener);
    signal?.addEventListener('abort', () => wake?.());

    try {
      while (!signal?.aborted) {
        const event = events.shift();

        if (event) {
          yield event;
          continue;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      listeners.delete(listener);
    }
  }

  const engine: SessionEngine = {
    create: (input) => {
      calls.push(`create:${input.model}`);
      creates.push(input);

      const created = info('ses_new');

      sessions.set(created.id, created);

      return Promise.resolve(created);
    },
    prompt: (input) => {
      calls.push(`prompt:${input.messageID}`);
      prompts.push(input);

      const admitted: Admitted = {
        messageID: input.messageID ?? 'msg_minted',
        done: Promise.resolve(),
      };

      if (running) queue.push({ messageID: admitted.messageID, parts: input.parts });

      return Promise.resolve(admitted);
    },
    compact: ({ sessionID: id }) => {
      calls.push(`compact:${id}`);

      return Promise.resolve({ status: 'completed' });
    },
    abort: (id) => void calls.push(`abort:${id}`),
    cancel: (id, messageID) => {
      calls.push(`cancel:${messageID}`);

      const index = queue.findIndex((entry) => entry.messageID === messageID);

      if (index < 0) return false;

      queue.splice(index, 1);

      return true;
    },
    sweep: () => Promise.resolve(),
    queued: () => [...queue],
    busy: () => false,
    log: (options) => log(options),
    head: () => Promise.resolve(seq),
    watch: (listener) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    messages: () => Promise.resolve<SessionMessage[]>([]),
    sessions: {
      list: () => Promise.resolve([...sessions.values()]),
      get: (id) => Promise.resolve(sessions.get(id)),
      rename: (id, title) => {
        const found = sessions.get(id);

        if (found) sessions.set(id, { ...found, title });

        return Promise.resolve();
      },
      delete: (id) => {
        calls.push(`delete:${id}`);
        sessions.delete(id);

        return Promise.resolve();
      },
    },
  };

  return {
    engine,
    calls,
    prompts,
    creates,
    play,
    sessions,
    hold: () => {
      running = true;
    },
  };
}
