import { z } from 'zod';

import { defineStorageItem } from './item';

export const theme = defineStorageItem('theme', z.enum(['light', 'dark', 'system']), 'system');

/** The web search choice, as OpenCode v2's `websearch:provider`: a provider id, `'random'`, or `false` for off. */
export type WebSearchChoice = string | false;

export const webSearchProvider = defineStorageItem<WebSearchChoice | undefined>(
  'websearch:provider',
  z.union([z.string().min(1), z.literal(false)]).optional(),
  undefined,
);
