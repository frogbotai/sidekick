import { z } from 'zod';

import { ToolError } from '../../tool/tool';
import { messageOf, stopped } from './abort';
import { createPacer, type Pacer, type Quality } from './pacing';
import type { Runs } from './runs';
import type { Sessions } from './sessions';
import type { Cdp, Encoder, SavedVideo } from './types';

export const DEFAULT_FRAME_RATE = 10;

export const DEFAULT_MAX_DURATION_MS = 15 * 60_000;

/** The video is held in memory until it's saved, so a recording lasts an hour at most. */
export const MAX_DURATION_MS = 60 * 60_000;

/** How long the screencast may stay silent at the start before screenshots stand in. */
export const FALLBACK_GRACE_MS = 1_500;

/** How long it may go quiet mid-recording before screenshots fill in. */
export const QUIET_GRACE_MS = 400;

const MAX_FALLBACK_BACKOFF_MS = 1_000;

const MAX_FALLBACK_FRAME_RATE = 10;

const QUALITY = 80;

/** Why a recording stopped itself; the next `record_status` or `record_stop` says so. */
export type EndReason = 'tab_closed' | 'detached' | 'max_duration' | 'run_stopped';

export interface RecordingReport extends Quality, SavedVideo {
  duration_ms: number;
  frame_rate: number;
}

export type RecordingStatus =
  | ({ recording: true; duration_ms: number; frame_rate: number } & Quality)
  | ({ recording: false; ended: EndReason } & RecordingReport)
  | { recording: false; ended: EndReason; error: string }
  | { recording: false };

export interface Recordings {
  start(input: {
    runId: string;
    tabId: number;
    origin: string;
    frameRate: number;
    maxDurationMs: number;
  }): Promise<void>;
  /** The site a run's recording of `tabId` started on, for its permission check. */
  originOf(runId: string, tabId: number): string | undefined;
  status(runId: string, tabId: number): Promise<RecordingStatus>;
  stop(runId: string, tabId: number): Promise<RecordingReport>;
  dispose(): void;
}

interface Active {
  id: string;
  runId: string;
  tabId: number;
  origin: string;
  frameRate: number;
  started: number;
  pacer: Pacer;
  limit: ReturnType<typeof setTimeout>;
  fallback?: ReturnType<typeof setTimeout>;
  backoff: number;
  previous?: string;
}

interface Ended {
  runId: string;
  origin: string;
  reason: EndReason;
  report: Promise<RecordingReport>;
}

const frameEvent = z.object({ data: z.string(), sessionId: z.number() });

const shot = z.object({ data: z.string() });

/** The file a recording downloads as, by its start time: `sidekick-recording-2026-11-18-14-03-22.mp4`. */
export function recordingFile(started: number) {
  const stamp = new Date(started).toISOString().slice(0, 19).replace(/[T:]/g, '-');

  return `sidekick-recording-${stamp}.mp4`;
}

function running(active: Active) {
  return new ToolError(
    'recording_running',
    `Tab ${active.tabId} is already recording (for ${Math.round((Date.now() - active.started) / 1000)} s, at ${active.frameRate} fps). Stop it with record_stop first.`,
  );
}

function noRecording(tabId: number) {
  return new ToolError(
    'no_recording',
    `Nothing is recording tab ${tabId} in this task. Start with record_start.`,
  );
}

/**
 * Records tabs over the CDP screencast, one recording per tab, ported from browse's
 * `screencast.rs` and `recording.rs`: every frame acknowledged, screenshots when the screencast is
 * quiet, frames paced onto a fixed grid, and a self-stop on tab close, detach, the time limit or
 * the end of the run.
 */
export function createRecordings({
  cdp,
  sessions,
  encoder,
  runs,
}: {
  cdp: Cdp;
  sessions: Sessions;
  encoder: Encoder;
  runs: Runs;
}): Recordings {
  const active = new Map<number, Active>();
  const ended = new Map<number, Ended>();

  const since = (recording: Active) => Date.now() - recording.started;

  const interval = (frameRate: number) => 1000 / Math.min(frameRate, MAX_FALLBACK_FRAME_RATE);

  const still = async (tabId: number) => {
    const result = await sessions.send(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: QUALITY,
      fromSurface: true,
      captureBeyondViewport: false,
    });

    return shot.parse(result).data;
  };

  const schedule = (recording: Active, ms: number) => {
    clearTimeout(recording.fallback);
    recording.fallback = setTimeout(() => void fill(recording), ms);
  };

  const fill = async (recording: Active) => {
    const started = Date.now();
    const data = await still(recording.tabId).catch(() => undefined);

    if (active.get(recording.tabId) !== recording) return;

    if (data !== undefined) {
      const unchanged = data === recording.previous;

      recording.backoff = unchanged
        ? Math.min(recording.backoff * 2, MAX_FALLBACK_BACKOFF_MS)
        : interval(recording.frameRate);

      recording.previous = data;
      recording.pacer.push({ data, at: since(recording), fallback: true });
    }

    schedule(recording, Math.max(0, started + recording.backoff - Date.now()));
  };

  const finish = async (recording: Active, attached: boolean): Promise<RecordingReport> => {
    clearTimeout(recording.limit);
    clearTimeout(recording.fallback);

    if (attached) {
      await sessions.send(recording.tabId, 'Page.stopScreencast').catch(() => undefined);
    }

    const at = since(recording);
    const fresh = () =>
      attached ? still(recording.tabId).catch(() => undefined) : Promise.resolve(undefined);

    await recording.pacer.finish(at, fresh);

    try {
      const saved = await encoder.close(recording.id, recordingFile(recording.started));

      return {
        ...saved,
        duration_ms: at,
        frame_rate: recording.frameRate,
        ...recording.pacer.quality(at),
      };
    } catch (error) {
      await encoder.cancel(recording.id).catch(() => undefined);

      throw error;
    }
  };

  const end = (recording: Active, reason: EndReason) => {
    if (active.get(recording.tabId) !== recording) return;

    active.delete(recording.tabId);

    const attached = reason === 'max_duration' || reason === 'run_stopped';
    const report = finish(recording, attached);

    report.catch(() => undefined);

    ended.set(recording.tabId, {
      runId: recording.runId,
      origin: recording.origin,
      reason,
      report,
    });
  };

  const unsubscribers = [
    cdp.onEvent(({ tabId, method, params }) => {
      const recording = active.get(tabId);

      if (!recording || method !== 'Page.screencastFrame') return;

      const frame = frameEvent.safeParse(params);

      if (!frame.success) return;

      void sessions
        .send(tabId, 'Page.screencastFrameAck', { sessionId: frame.data.sessionId })
        .catch(() => undefined);

      recording.backoff = interval(recording.frameRate);
      recording.previous = frame.data.data;
      recording.pacer.push({ data: frame.data.data, at: since(recording) });
      schedule(recording, QUIET_GRACE_MS);
    }),
    cdp.onDetach((tabId, reason) => {
      const recording = active.get(tabId);

      if (recording) end(recording, reason === 'target_closed' ? 'tab_closed' : 'detached');
    }),
    runs.onStopped(({ runId }) => {
      for (const recording of [...active.values()]) {
        if (recording.runId === runId) end(recording, 'run_stopped');
      }
    }),
  ];

  const mine = <T extends { runId: string }>(entry: T | undefined, runId: string) =>
    entry?.runId === runId ? entry : undefined;

  return {
    start: async ({ runId, tabId, origin, frameRate, maxDurationMs }) => {
      const current = active.get(tabId);

      if (current) throw running(current);

      const id = crypto.randomUUID();

      await encoder.open(id, { frameRate });

      if (!runs.get(runId)) {
        await encoder.cancel(id).catch(() => undefined);

        throw stopped();
      }

      const recording: Active = {
        id,
        runId,
        tabId,
        origin,
        frameRate,
        started: Date.now(),
        pacer: createPacer({
          frameRate,
          write: (frame) => encoder.frame(id, frame),
        }),
        limit: setTimeout(() => end(recording, 'max_duration'), maxDurationMs),
        backoff: interval(frameRate),
      };

      active.set(tabId, recording);
      ended.delete(tabId);

      try {
        await sessions.send(tabId, 'Page.startScreencast', {
          format: 'jpeg',
          quality: QUALITY,
          everyNthFrame: 1,
        });
      } catch (error) {
        clearTimeout(recording.limit);
        active.delete(tabId);
        await encoder.cancel(id).catch(() => undefined);

        throw error;
      }

      if (active.get(tabId) === recording) schedule(recording, FALLBACK_GRACE_MS);
    },
    originOf: (runId, tabId) =>
      (mine(active.get(tabId), runId) ?? mine(ended.get(tabId), runId))?.origin,
    status: async (runId, tabId) => {
      const recording = mine(active.get(tabId), runId);

      if (recording) {
        const at = since(recording);

        return {
          recording: true,
          duration_ms: at,
          frame_rate: recording.frameRate,
          ...recording.pacer.quality(at),
        };
      }

      const last = mine(ended.get(tabId), runId);

      if (!last) return { recording: false };

      try {
        return { recording: false, ended: last.reason, ...(await last.report) };
      } catch (error) {
        return { recording: false, ended: last.reason, error: messageOf(error) };
      }
    },
    stop: async (runId, tabId) => {
      const recording = mine(active.get(tabId), runId);

      if (recording) {
        active.delete(tabId);

        return finish(recording, true);
      }

      const last = mine(ended.get(tabId), runId);

      if (!last) throw noRecording(tabId);

      ended.delete(tabId);

      return last.report.catch((error: unknown) => {
        throw new ToolError(
          'no_recording',
          `The recording of tab ${tabId} stopped (${last.reason}) and saved nothing: ${messageOf(error)}`,
        );
      });
    },
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();

      for (const recording of [...active.values()]) {
        clearTimeout(recording.limit);
        clearTimeout(recording.fallback);
        void encoder.cancel(recording.id).catch(() => undefined);
      }

      active.clear();
    },
  };
}
