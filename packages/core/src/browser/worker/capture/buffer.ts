/** How many entries a capture keeps before it drops the oldest, as browse does. */
export const CAPTURE_LIMIT = 1_000;

/** A capture's entries since the last read, oldest first, and how many were dropped unread. */
export interface Taken<T> {
  entries: T[];
  dropped: number;
}

/** A ring buffer that keeps the newest `limit` entries; `take` empties it, so each read sees only newer entries. */
export interface CaptureBuffer<T> {
  push(entry: T): void;
  take(): Taken<T>;
}

export function createBuffer<T>(limit = CAPTURE_LIMIT): CaptureBuffer<T> {
  let entries: T[] = [];
  let dropped = 0;

  return {
    push: (entry) => {
      entries.push(entry);

      if (entries.length > limit) {
        entries.shift();
        dropped++;
      }
    },
    take: () => {
      const taken = { entries, dropped };

      entries = [];
      dropped = 0;

      return taken;
    },
  };
}
