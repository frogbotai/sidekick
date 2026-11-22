import { z } from 'zod';

import { MODIFIERS } from '../keys';

export const tabId = z
  .number()
  .int()
  .nonnegative()
  .describe('The tab, from tabs_list or tabs_open.');

/** One call at a time per tab, so a read after `navigate` sees the new page. */
export function byTab({ tab_id }: { tab_id: number }) {
  return `tab:${tab_id}`;
}

export const ref = z
  .string()
  .regex(/^f\d+e\d+$/)
  .describe('An element ref from the latest snapshot, like f0e12.');

export const coordinate = z.number().nonnegative();

export const pointer = {
  tab_id: tabId,
  ref: ref.optional(),
  x: coordinate
    .optional()
    .describe('Pixels from the left of the last screenshot, for pages without refs.'),
  y: coordinate.optional().describe('Pixels from the top of the last screenshot.'),
};

export const modifiers = z.array(z.enum(MODIFIERS)).max(4).optional();

export const challenge = z
  .object({
    vendor: z.string(),
    kind: z.enum(['non-interactive', 'interactive', 'block']),
    status: z.enum(['cleared', 'blocked']),
    recommendation: z.enum(['continue', 'handoff', 'stop']),
    message: z.string(),
  })
  .optional()
  .describe(
    'Only when the page is a captcha, bot check or block page. handoff: stop and ask the person to solve it in this tab. stop: the site refused the visit; don’t retry or reload. continue: a check cleared by itself.',
  );

export const action = z.object({
  url: z.string(),
  navigated: z
    .boolean()
    .describe(
      'navigate: a new page loaded (a reload counts). Other actions: the URL changed during the action.',
    ),
  settled: z.boolean().describe('The page went quiet before the time limit.'),
  challenge,
});

export const tab = z.object({
  tab_id: z.number(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});

export const tabList = z.object({ tabs: z.array(tab) });
