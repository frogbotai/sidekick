import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import type { Overrides } from '../emulation';
import { type BrowserEnv, enter, untrusted } from '../env';
import { byTab, tabId } from './schema';

const OVERRIDES = [
  'viewport',
  'color_scheme',
  'reduced_motion',
  'user_agent',
  'geolocation',
] as const;

const viewport = z.object({
  width: z.number().int().min(1).max(10_000).describe('CSS pixels, like 390 for a phone.'),
  height: z.number().int().min(1).max(10_000).describe('CSS pixels, like 844 for a phone.'),
  device_scale_factor: z
    .number()
    .positive()
    .max(10)
    .optional()
    .describe('Device pixels per CSS pixel, like 3 for a phone; the screen’s own when left out.'),
  mobile: z
    .boolean()
    .optional()
    .describe('Lay the page out as a phone browser does, with its meta viewport.'),
});

const geolocation = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().optional().describe('Metres; 10 when left out.'),
});

const active = z.object({
  viewport: viewport.optional(),
  color_scheme: z.enum(['light', 'dark']).optional(),
  reduced_motion: z.enum(['reduce', 'no-preference']).optional(),
  user_agent: z.string().optional(),
  geolocation: geolocation.optional(),
});

function notes(overrides: Overrides) {
  return [
    ...(overrides.user_agent === undefined
      ? []
      : ['The user agent applies from the next request; reload to send it to the page.']),
    ...(overrides.geolocation === undefined
      ? []
      : ['The location only reaches sites that already have location permission.']),
  ];
}

export function emulateTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'emulate',
      description:
        'Change how a tab looks to its page: viewport size and phone layout, dark or light mode, reduced motion, user agent or location. Settings add to the ones already set, and stay until reset: true or until the task hands the tab back. Use it to check a page on a phone or in dark mode.',
      input: z.object({
        tab_id: tabId,
        viewport: viewport.optional(),
        color_scheme: z.enum(['light', 'dark']).optional(),
        reduced_motion: z.enum(['reduce', 'no-preference']).optional(),
        user_agent: z.string().trim().min(1).max(1_000).optional(),
        geolocation: geolocation.optional(),
        reset: z
          .literal(true)
          .optional()
          .describe('Clear every override on the tab first; the others given then apply.'),
      }),
      output: z.object({
        active: active.describe('The overrides now active on the tab.'),
        notes: z.array(z.string()),
      }),
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, reset, ...overrides }, ctx) => {
        if (!reset && OVERRIDES.every((key) => overrides[key] === undefined)) {
          throw new ToolError(
            'invalid_target',
            `Give at least one of ${OVERRIDES.join(', ')}, or reset: true.`,
          );
        }

        const act = await enter(env, ctx, tab_id, 'input');

        if (reset || overrides.viewport) env.screens.delete(tab_id);

        if (reset) await env.emulation.reset(tab_id, act.signal);

        const now = await env.emulation.set({
          tabId: tab_id,
          runId: act.run.id,
          overrides,
          signal: act.signal,
        });

        return untrusted({ active: now, notes: notes(overrides) });
      },
    }),
  ];
}
