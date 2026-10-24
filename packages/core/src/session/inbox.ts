import { COMPACTION_INTERRUPTED } from './compaction';
import type { PromptEntry } from './queue';
import { type CompactOutcome, type CompactResult, manualResult } from './summarize';

export const COMPACT_INTERRUPTED: CompactResult = {
  status: 'failed',
  error: { type: 'aborted', message: COMPACTION_INTERRUPTED },
};

/** How `end` admits what a turn didn't reach. */
export interface Resume {
  compact: () => Promise<CompactResult>;
  prompt: (entry: PromptEntry) => void;
}

/**
 * Steers and compactions sent to this window's running turn, after OpenCode v2's inbox. The turn
 * takes them at its step boundaries, compactions first; whatever it ends before reaching starts
 * after it, the compactions, then one turn that writes every waiting steer.
 */
export interface Inbox {
  /** Marks the session's turn running here, from the moment its lock is taken. */
  begin: (sessionID: string) => void;
  turning: (sessionID: string) => boolean;
  /** Holds a steer for the next boundary; the same message id twice is held once. */
  steer: (entry: PromptEntry) => void;
  /** Holds a compaction for the next boundary, settling with its result. */
  compact: (sessionID: string) => Promise<CompactResult>;
  /**
   * At a boundary: runs the waiting compactions once, through `run`, which never throws, then
   * hands over the steers, unless the compaction ended the turn.
   */
  take: (
    sessionID: string,
    run: () => Promise<CompactOutcome>,
  ) => Promise<{ compacted?: CompactOutcome; steers: PromptEntry[] }>;
  /** The steers a resumed turn writes after its own message. */
  followers: (messageID: string) => PromptEntry[];
  /** Ends the turn, admitting through `resume` what it didn't reach. */
  end: (sessionID: string, resume: Resume) => void;
  /** Forgets the steers that would follow a cancelled message. */
  cancel: (messageID: string) => void;
  /** Forgets a deleted session's steers, and settles its compactions interrupted. */
  drop: (sessionID: string) => void;
}

export function createInbox(): Inbox {
  const turning = new Set<string>();
  const steers = new Map<string, PromptEntry[]>();
  const compactions = new Map<string, ((result: CompactResult) => void)[]>();
  const followers = new Map<string, PromptEntry[]>();

  const takeCompactions = (sessionID: string) => {
    const waiting = compactions.get(sessionID);

    compactions.delete(sessionID);

    return waiting;
  };

  const takeSteers = (sessionID: string) => {
    const list = steers.get(sessionID) ?? [];

    steers.delete(sessionID);

    return list;
  };

  return {
    begin: (sessionID) => void turning.add(sessionID),
    turning: (sessionID) => turning.has(sessionID),
    steer: (entry) => {
      const list = steers.get(entry.sessionID) ?? [];

      if (list.some(({ messageID }) => messageID === entry.messageID)) return;

      steers.set(entry.sessionID, [...list, entry]);
    },
    compact: (sessionID) =>
      new Promise((resolve) => {
        compactions.set(sessionID, [...(compactions.get(sessionID) ?? []), resolve]);
      }),
    take: async (sessionID, run) => {
      const waiting = takeCompactions(sessionID);

      if (!waiting) return { steers: takeSteers(sessionID) };

      const compacted = await run();

      for (const resolve of waiting) resolve(manualResult(compacted));

      const ended = compacted.status === 'failed' || compacted.status === 'aborted';

      return { compacted, steers: ended ? [] : takeSteers(sessionID) };
    },
    followers: (messageID) => {
      const list = followers.get(messageID) ?? [];

      followers.delete(messageID);

      return list;
    },
    end: (sessionID, resume) => {
      turning.delete(sessionID);

      const waiting = takeCompactions(sessionID);
      const [first, ...rest] = takeSteers(sessionID);

      if (waiting) {
        const later = resume.compact();

        for (const resolve of waiting) void later.then(resolve);
      }

      if (!first) return;

      if (rest.length > 0) followers.set(first.messageID, rest);

      resume.prompt(first);
    },
    cancel: (messageID) => void followers.delete(messageID),
    drop: (sessionID) => {
      steers.delete(sessionID);

      for (const resolve of takeCompactions(sessionID) ?? []) resolve(COMPACT_INTERRUPTED);
    },
  };
}
