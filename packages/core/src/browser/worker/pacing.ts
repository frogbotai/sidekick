/** A JPEG frame of a recording, shown from `timestamp` for `duration`, both in seconds. */
export interface PacedFrame {
  data: string;
  timestamp: number;
  duration: number;
}

/** How well a recording kept up, as `record_status` and `record_stop` report it. */
export interface Quality {
  frames_captured: number;
  frames_written: number;
  frames_coalesced: number;
  frames_dropped: number;
  /** Frames captured per second of recording. */
  fps: number;
  /** Screenshots stood in while the screencast sent nothing. */
  screenshot_fallback: boolean;
}

export interface Pacer {
  /** A captured frame, `at` milliseconds after the recording started. */
  push(frame: { data: string; at: number; fallback?: boolean }): void;
  /**
   * Writes the held frame, or `still()` when no frame came, shown until `at`, then waits for every
   * write. The final frame is never dropped.
   */
  finish(at: number, still: () => Promise<string | undefined>): Promise<void>;
  quality(at: number): Quality;
}

export const MAX_PENDING_FRAMES = 30;

/**
 * browse's fixed-rate grid: the first frame at 0, later ones snapped to `1 / frameRate`, frames on
 * one slot coalesced to the newest, and at most `limit` writes pending; the rest are dropped.
 */
export function createPacer({
  frameRate,
  write,
  limit = MAX_PENDING_FRAMES,
}: {
  frameRate: number;
  write: (frame: PacedFrame) => Promise<void>;
  limit?: number;
}): Pacer {
  const pending = new Set<Promise<void>>();
  const counts = { captured: 0, written: 0, coalesced: 0, dropped: 0, fallback: 0 };
  let last: { data: string; slot: number } | undefined;

  const send = (data: string, slot: number, end: number, force = false) => {
    if (!force && pending.size >= limit) {
      counts.dropped += 1;

      return;
    }

    const sent = write({ data, timestamp: slot / frameRate, duration: (end - slot) / frameRate })
      .then(
        () => void (counts.written += 1),
        () => void (counts.dropped += 1),
      )
      .finally(() => pending.delete(sent));

    pending.add(sent);
  };

  return {
    push: ({ data, at, fallback = false }) => {
      counts.captured += 1;

      if (fallback) counts.fallback += 1;

      const position = (at / 1000) * frameRate;
      let slot = counts.captured === 1 ? 0 : Math.floor(position);

      if (last) {
        if (slot === last.slot && position - slot >= 0.5) slot = last.slot + 1;

        slot = Math.max(slot, last.slot);

        if (slot === last.slot) counts.coalesced += 1;
        else send(last.data, last.slot, slot);
      }

      last = { data, slot };
    },
    finish: async (at, still) => {
      const fresh = last ? undefined : await still();
      const held = last ?? (fresh === undefined ? undefined : { data: fresh, slot: 0 });

      last = undefined;

      if (held) {
        const end = Math.max(Math.round((at / 1000) * frameRate), held.slot + 1);

        send(held.data, held.slot, end, true);
      }

      while (pending.size > 0) await Promise.all(pending);
    },
    quality: (at) => ({
      frames_captured: counts.captured,
      frames_written: counts.written,
      frames_coalesced: counts.coalesced,
      frames_dropped: counts.dropped,
      fps: Math.round((counts.captured / Math.max(at / 1000, 0.001)) * 10) / 10,
      screenshot_fallback: counts.fallback > 0,
    }),
  };
}
