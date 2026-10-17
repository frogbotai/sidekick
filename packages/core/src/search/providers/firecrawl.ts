import { z } from 'zod';

import { mcpCall } from '../mcp';
import type { SearchProvider } from '../registry';
import { activeKey } from './key';

export const endpoint = 'https://mcp.firecrawl.dev/v2/mcp';

const Output = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const Answer = z.object({
  success: z.boolean(),
  data: z.object({
    web: z.array(
      z.object({
        url: z.string(),
        title: z.string().nullish(),
        description: z.string().nullish(),
      }),
    ),
  }),
});

function answer(text: string) {
  try {
    const parsed = Answer.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Firecrawl's hosted MCP `firecrawl_search`, keyless, with a pasted key as a bearer token, after OpenCode v2. */
export const firecrawl: SearchProvider = {
  id: 'firecrawl',
  name: 'Firecrawl',
  key: {
    url: 'https://www.firecrawl.dev/app/api-keys',
    hint: 'the Firecrawl dashboard',
  },
  search: async (query, signal) => {
    const key = await activeKey('firecrawl');
    const result = Output.safeParse(
      await mcpCall(
        endpoint,
        'firecrawl_search',
        { query, limit: 8 },
        key ? { Authorization: `Bearer ${key}` } : {},
        signal,
      ),
    );

    const text = result.success ? result.data.content.find((item) => item.text)?.text : undefined;
    const response = text ? answer(text) : undefined;

    return (
      response?.data.web.map((item) => ({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(item.description ? { content: item.description } : {}),
      })) ?? []
    );
  },
};
