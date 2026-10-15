import { complete, MESSAGE_ORDER, SESSION_STORES, settle } from '../storage/database';
import { reduce, type Reducer, targetOf } from './reducer';
import type {
  DurableEventBody,
  EphemeralEvent,
  EphemeralEventBody,
  LogEvent,
  SessionEvent,
  SessionInfo,
  SessionMessage,
} from './schema';
import { isDurable } from './schema';

const { events: EVENTS, sessions: SESSIONS, messages: MESSAGES } = SESSION_STORES;

const ALL = [EVENTS, SESSIONS, MESSAGES];

export interface LogOptions {
  sessionID: string;
  /** Replays events with a larger `seq`; 0 replays them all. */
  after?: number;
  /** Keeps yielding live events, deltas included, until `signal` aborts. */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface SessionList {
  list: (options?: { parentID?: string }) => Promise<SessionInfo[]>;
  get: (id: string) => Promise<SessionInfo | undefined>;
  rename: (id: string, title: string) => Promise<void>;
  /** Removes the session's events and its projection. */
  delete: (id: string) => Promise<void>;
}

/** Sessions in IndexedDB: an event log plus its projection, after v2's bus and session tables. */
export interface SessionStore {
  /** Commits a durable event with its projection, in one transaction, then tells followers. */
  publish: (sessionID: string, body: DurableEventBody) => Promise<SessionEvent>;
  /** Tells followers about a live-only event; nothing is stored. */
  emit: (sessionID: string, body: EphemeralEventBody) => void;
  log: (options: LogOptions) => AsyncGenerator<LogEvent>;
  events: (sessionID: string, after?: number) => Promise<SessionEvent[]>;
  messages: (sessionID: string) => Promise<SessionMessage[]>;
  /** The session's latest message, read without loading the rest. */
  last: (sessionID: string) => Promise<SessionMessage | undefined>;
  /** Every session, children included. */
  all: () => Promise<SessionInfo[]>;
  sessions: SessionList;
}

export interface SessionStoreOptions {
  reducer?: Reducer;
  now?: () => number;
}

function sessionRange(sessionID: string, after = 0) {
  return IDBKeyRange.bound([sessionID, after], [sessionID, Infinity], true);
}

async function commit(transaction: IDBTransaction, work: () => Promise<void>) {
  const done = complete(transaction);

  try {
    await work();
  } catch (error) {
    transaction.abort();
    await done.catch(() => undefined);

    throw error;
  }

  await done;
}

export function createSessionStore(
  database: IDBDatabase,
  { reducer = reduce, now = Date.now }: SessionStoreOptions = {},
): SessionStore {
  const listeners = new Map<string, Set<(event: LogEvent) => void>>();

  const notify = (event: LogEvent) => {
    for (const listener of [...(listeners.get(event.sessionID) ?? [])]) listener(event);
  };

  const listen = (sessionID: string, listener: (event: LogEvent) => void) => {
    const set = listeners.get(sessionID) ?? new Set();

    set.add(listener);
    listeners.set(sessionID, set);

    return () => {
      set.delete(listener);

      if (set.size === 0) listeners.delete(sessionID);
    };
  };

  const events = async (sessionID: string, after = 0) => {
    const transaction = database.transaction(EVENTS, 'readonly');

    return settle<SessionEvent[]>(
      transaction.objectStore(EVENTS).getAll(sessionRange(sessionID, after)),
    );
  };

  const publish = async (sessionID: string, body: DurableEventBody) => {
    const transaction = database.transaction(ALL, 'readwrite');
    let stored: SessionEvent | undefined;

    await commit(transaction, async () => {
      const log = transaction.objectStore(EVENTS);
      const sessions = transaction.objectStore(SESSIONS);
      const messages = transaction.objectStore(MESSAGES);
      const last = await settle(log.openCursor(sessionRange(sessionID), 'prev'));
      const seq = last ? (last.value as SessionEvent).seq + 1 : 1;
      const event: SessionEvent = {
        id: crypto.randomUUID(),
        sessionID,
        seq,
        created: now(),
        ...body,
      };

      const id = targetOf(event);
      const session = await settle<SessionInfo | undefined>(sessions.get(sessionID));

      if (!session && body.type !== 'session.created') throw new Error(`No session ${sessionID}`);

      const found =
        id === undefined ? undefined : await settle<SessionMessage | undefined>(messages.get(id));

      const message = found?.sessionID === sessionID ? found : undefined;
      const change = reducer({ session, message }, event);

      if (change.session) sessions.put(change.session);

      if (change.message) messages.put(change.message);

      if (change.deleteFrom !== undefined) {
        const range = IDBKeyRange.bound([sessionID, change.deleteFrom], [sessionID, Infinity]);
        const keys = await settle(messages.index(MESSAGE_ORDER).getAllKeys(range));

        for (const key of keys) messages.delete(key);
      }

      log.add(event);
      stored = event;
    });

    if (!stored) throw new Error('IndexedDB commit lost its event');

    notify(stored);

    return stored;
  };

  const emit = (sessionID: string, body: EphemeralEventBody) => {
    const event: EphemeralEvent = { sessionID, created: now(), ...body };

    notify(event);
  };

  async function* log({ sessionID, after = 0, follow = false, signal }: LogOptions) {
    const queue: LogEvent[] = [];
    let wake: (() => void) | undefined;

    const unsubscribe = follow
      ? listen(sessionID, (event) => {
          queue.push(event);
          wake?.();
        })
      : undefined;

    const stop = () => wake?.();

    signal?.addEventListener('abort', stop);

    try {
      let last = after;

      for (const event of await events(sessionID, after)) {
        last = event.seq;

        yield event;
      }

      while (follow && !signal?.aborted) {
        const event = queue.shift();

        if (!event) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });

          wake = undefined;
          continue;
        }

        if (isDurable(event)) {
          if (event.seq <= last) continue;

          last = event.seq;
        }

        yield event;
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      unsubscribe?.();
    }
  }

  const messages = async (sessionID: string) => {
    const transaction = database.transaction(MESSAGES, 'readonly');
    const range = IDBKeyRange.bound([sessionID, 0], [sessionID, Infinity]);

    return settle<SessionMessage[]>(
      transaction.objectStore(MESSAGES).index(MESSAGE_ORDER).getAll(range),
    );
  };

  const last = async (sessionID: string) => {
    const transaction = database.transaction(MESSAGES, 'readonly');
    const range = IDBKeyRange.bound([sessionID, 0], [sessionID, Infinity]);
    const index = transaction.objectStore(MESSAGES).index(MESSAGE_ORDER);
    const cursor = await settle(index.openCursor(range, 'prev'));

    return cursor ? (cursor.value as SessionMessage) : undefined;
  };

  const all = async () => {
    const transaction = database.transaction(SESSIONS, 'readonly');

    return settle<SessionInfo[]>(transaction.objectStore(SESSIONS).getAll());
  };

  const get = async (id: string) => {
    const transaction = database.transaction(SESSIONS, 'readonly');

    return settle<SessionInfo | undefined>(transaction.objectStore(SESSIONS).get(id));
  };

  return {
    publish,
    emit,
    log,
    events,
    messages,
    last,
    all,
    sessions: {
      list: async ({ parentID }: { parentID?: string } = {}) =>
        (await all())
          .filter((session) => session.parentID === parentID)
          .sort((a, b) => b.updated - a.updated),
      get,
      rename: async (id, title) => {
        if (!(await get(id))) throw new Error(`No session ${id}`);

        await publish(id, { type: 'session.renamed', title });
      },
      delete: async (id) => {
        const transaction = database.transaction(ALL, 'readwrite');

        await commit(transaction, async () => {
          const messages = transaction.objectStore(MESSAGES);
          const range = IDBKeyRange.bound([id, 0], [id, Infinity]);
          const keys = await settle(messages.index(MESSAGE_ORDER).getAllKeys(range));

          for (const key of keys) messages.delete(key);

          transaction.objectStore(EVENTS).delete(range);
          transaction.objectStore(SESSIONS).delete(id);
        });

        emit(id, { type: 'session.deleted' });
      },
    },
  };
}
