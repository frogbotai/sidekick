import { z } from 'zod';

import { ToolError } from '../../tool/tool';
import { searchFetch } from '../http';
import type { SearchProvider } from '../registry';
import { activeKey } from './key';

export const endpoint = 'https://api.tavily.com/search';

const Answer = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })),
});

function answer(text: string) {
  try {
    return Answer.safeParse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Tavily's `/search` REST API, keyless through `X-Tavily-Access-Mode`, or with a pasted key, after OpenCode v2. */
export const tavily: SearchProvider = {
  id: 'tavily',
  name: 'Tavily',
  key: { url: 'https://app.tavily.com/home', hint: 'the Tavily dashboard' },
  search: async (query, signal) => {
    const key = await activeKey('tavily');
    const body = await searchFetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Client-Name': 'sidekick',
          ...(key ? { Authorization: `Bearer ${key}` } : { 'X-Tavily-Access-Mode': 'keyless' }),
        },
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          chunks_per_source: 3,
          max_results: 8,
        }),
      },
      signal,
      'Tavily',
    );

    const parsed = answer(body);

    if (!parsed?.success) throw new ToolError('request_failed', 'Tavily sent an unreadable answer');

    return parsed.data.results.map((item) => ({
      url: item.url,
      title: item.title,
      ...(item.content ? { content: item.content } : {}),
    }));
  },
};
