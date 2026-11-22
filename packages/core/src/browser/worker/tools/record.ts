import { z } from 'zod';

import { defineTool } from '../../../tool/tool';
import { race } from '../abort';
import { type BrowserEnv, enter, runOf, send, untrusted } from '../env';
import { DEFAULT_FRAME_RATE, DEFAULT_MAX_DURATION_MS, MAX_DURATION_MS } from '../videos';
import { byTab, tabId } from './schema';

const quality = {
  frames_captured: z.number(),
  frames_written: z.number(),
  frames_coalesced: z.number(),
  frames_dropped: z.number(),
  fps: z.number().describe('Video frames per second achieved, at most frame_rate.'),
  screenshot_fallback: z.boolean(),
};

const report = z.object({
  file: z.string().describe('The file name in the person’s Downloads folder.'),
  codec: z.string(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  duration_ms: z.number(),
  frame_rate: z.number(),
  ...quality,
});

const ENDED = z.enum(['tab_closed', 'detached', 'max_duration', 'run_stopped']);

export function recordTools(env: BrowserEnv) {
  const checked = async (ctx: Parameters<typeof runOf>[1], tab_id: number) => {
    const { run, signal } = runOf(env, ctx);
    const origin = env.videos.originOf(run.id, tab_id);

    if (origin !== undefined) {
      await race(ctx.permission.assert({ action: 'read', resource: origin }), signal);
    }

    return { run, signal };
  };

  return [
    defineTool({
      id: 'record_start',
      description:
        'Start recording a tab as a video for the person; you can’t watch it. It keeps recording while you work, and record_stop saves it to their Downloads folder as an MP4. One recording per tab. It stops itself, keeping the video, when the tab closes, the time limit passes or the task ends.',
      input: z.object({
        tab_id: tabId,
        frame_rate: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe(`Frames per second, 1 to 60; ${DEFAULT_FRAME_RATE} when left out.`),
        max_duration_ms: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_DURATION_MS)
          .optional()
          .describe('Stop on its own after this long, at most an hour; 15 minutes when left out.'),
      }),
      output: z.object({
        recording: z.boolean(),
        frame_rate: z.number(),
        max_duration_ms: z.number(),
      }),
      permission: 'read',
      lock: byTab,
      execute: async (
        { tab_id, frame_rate = DEFAULT_FRAME_RATE, max_duration_ms = DEFAULT_MAX_DURATION_MS },
        ctx,
      ) => {
        const act = await enter(env, ctx, tab_id, 'read');

        if (!act.tab.active) {
          await send(act, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        }

        await race(
          env.videos.start({
            runId: act.run.id,
            tabId: tab_id,
            origin: act.origin,
            frameRate: frame_rate,
            maxDurationMs: max_duration_ms,
          }),
          act.signal,
        );

        return untrusted({ recording: true, frame_rate, max_duration_ms });
      },
    }),
    defineTool({
      id: 'record_status',
      description:
        'Say whether a tab is recording, for how long and how many frames it caught; or, if the recording stopped itself, why and the saved file.',
      input: z.object({ tab_id: tabId }),
      output: report.partial().extend({
        recording: z.boolean(),
        ended: ENDED.optional(),
        error: z.string().optional().describe('Why a recording that stopped itself saved nothing.'),
      }),
      permission: 'read',
      execute: async ({ tab_id }, ctx) => {
        const { run, signal } = await checked(ctx, tab_id);

        return untrusted(await race(env.videos.status(run.id, tab_id), signal));
      },
    }),
    defineTool({
      id: 'record_stop',
      description:
        'Stop recording a tab and save the video to the person’s Downloads folder as an MP4. Returns the file name and how well the recording kept up.',
      input: z.object({ tab_id: tabId }),
      output: report,
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id }, ctx) => {
        const { run } = await checked(ctx, tab_id);

        return untrusted(await env.videos.stop(run.id, tab_id));
      },
    }),
  ];
}
