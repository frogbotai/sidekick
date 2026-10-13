import { z } from 'zod';

import { MODIFIERS } from '../keys';

export const tabId = z
  .number()
  .int()
  .nonnegative()
  .describe('The tab, from tabs_list or tabs_open.');

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

export const action = z.object({
  url: z.string(),
  navigated: z.boolean().describe('The URL changed during the action.'),
  settled: z.boolean().describe('The page went quiet before the time limit.'),
});

export const tab = z.object({
  tab_id: z.number(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});

export const tabList = z.object({ tabs: z.array(tab) });
