import { z } from 'zod';

import { mcpCall } from '../mcp';
import type { SearchProvider } from '../registry';
import { activeKey } from './key';

export const endpoint = 'https://search.parallel.ai/mcp';

const Output = z.object({
  structuredContent: z.object({
    results: z.array(
      z.object({
        url: z.string(),
        title: z.string().nullish(),
        publish_date: z.string().nullish(),
        excerpts: z.array(z.string()),
      }),
    ),
  }),
});

/** Parallel's hosted MCP `web_search`, keyless, with a pasted key as a bearer token, after OpenCode v2. */
export const parallel: SearchProvider = {
  id: 'parallel',
  name: 'Parallel',
  key: { url: 'https://platform.parallel.ai/', hint: 'the Parallel platform' },
  search: async (query, signal) => {
    const key = await activeKey('parallel');
    const result = Output.safeParse(
      await mcpCall(
        endpoint,
        'web_search',
        { objective: query, search_queries: [query] },
        key ? { Authorization: `Bearer ${key}` } : {},
        signal,
      ),
    );

    if (!result.success) return [];

    return result.data.structuredContent.results.map((item) => {
      const published = item.publish_date ? Date.parse(item.publish_date) : Number.NaN;

      return {
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(item.excerpts.length > 0 ? { content: item.excerpts.join('\n\n') } : {}),
        ...(Number.isFinite(published) ? { published } : {}),
      };
    });
  },
};
