import type { UserPart } from './schema';

/** One exclusive lock per name across windows, as Web Locks give; `ifAvailable` skips a held one. */
export interface SessionLocks {
  run: <T>(name: string, ifAvailable: boolean, work: () => Promise<T>) => Promise<T | undefined>;
}

/** `navigator.locks`, as the engine uses it. */
export function webLocks(manager: LockManager = navigator.locks): SessionLocks {
  return {
    run: (name, ifAvailable, work) =>
      manager.request(name, { ifAvailable }, (lock) =>
        lock ? work() : Promise.resolve(undefined),
      ),
  };
}

/** The Web Lock a session's turn holds, in every window. */
export const lockName = (sessionID: string) => `sidekick.session.${sessionID}`;

export interface PromptInput {
  sessionID: string;
  /** The client's id for the message. Sending the same id again admits nothing new. */
  messageID?: string;
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

export interface PromptEntry extends PromptInput {
  kind: 'prompt';
  messageID: string;
}

/** A manual compaction, which waits behind a running turn like a message. */
export interface CompactEntry {
  kind: 'compact';
  sessionID: string;
  messageID: string;
}

export type Entry = PromptEntry | CompactEntry;

export interface Admitted {
  messageID: string;
  done: Promise<void>;
}

export interface QueueOptions {
  locks: SessionLocks;
  run: (entry: Entry) => Promise<void>;
  /** Whether the session already stores this message. */
  stored: (sessionID: string, messageID: string) => Promise<boolean>;
}

/** Messages waiting for their session's lock, admitted once per id. */
export interface SessionQueue {
  admit: (entry: Entry) => Promise<Admitted>;
  /** Takes back a message that hasn't started; false once it has. */
  cancel: (sessionID: string, messageID: string) => boolean;
  queued: (sessionID: string) => Queued[];
  /** Whether this window holds the session's lock. */
  holding: (sessionID: string) => boolean;
  /** Forgets a deleted session's waiting messages. */
  drop: (sessionID: string) => void;
}

interface Waiting {
  entry: Entry;
  done: Promise<void>;
  started: boolean;
}

export function createSessionQueue({ locks, run, stored }: QueueOptions): SessionQueue {
  const waiting = new Map<string, Waiting[]>();
  const admitted = new Map<string, Promise<void>>();
  const holding = new Set<string>();

  const remove = (sessionID: string, item: Waiting) => {
    const list = waiting.get(sessionID);
    const index = list?.indexOf(item) ?? -1;

    if (!list || index < 0) return false;

    list.splice(index, 1);

    if (list.length === 0) waiting.delete(sessionID);

    return true;
  };

  const start = (entry: Entry) => {
    const { sessionID } = entry;
    const item: Waiting = { entry, done: Promise.resolve(), started: false };
    const list = waiting.get(sessionID) ?? [];

    list.push(item);
    waiting.set(sessionID, list);

    item.done = locks
      .run(lockName(sessionID), false, async () => {
        if (!remove(sessionID, item)) return;

        item.started = true;
        holding.add(sessionID);

        try {
          await run(entry);
        } finally {
          holding.delete(sessionID);
        }
      })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => admitted.delete(entry.messageID));

    admitted.set(entry.messageID, item.done);

    return item.done;
  };

  return {
    admit: async (entry) => {
      const pending = admitted.get(entry.messageID);

      if (pending) return { messageID: entry.messageID, done: pending };

      const fresh = entry.kind === 'compact' || Boolean(entry.from);

      if (!fresh && (await stored(entry.sessionID, entry.messageID))) {
        return { messageID: entry.messageID, done: Promise.resolve() };
      }

      const again = admitted.get(entry.messageID);

      return { messageID: entry.messageID, done: again ?? start(entry) };
    },
    cancel: (sessionID, messageID) => {
      const item = waiting.get(sessionID)?.find(({ entry }) => entry.messageID === messageID);

      return item !== undefined && !item.started && remove(sessionID, item);
    },
    queued: (sessionID) =>
      (waiting.get(sessionID) ?? []).flatMap(({ entry }) =>
        entry.kind === 'prompt' ? [{ messageID: entry.messageID, parts: entry.parts }] : [],
      ),
    holding: (sessionID) => holding.has(sessionID),
    drop: (sessionID) => void waiting.delete(sessionID),
  };
}
