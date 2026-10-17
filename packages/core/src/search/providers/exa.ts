import { z } from 'zod';

import { mcpCall } from '../mcp';
import type { SearchProvider, SearchResult } from '../registry';
import { activeKey } from './key';

export const endpoint = 'https://mcp.exa.ai/mcp';

const Output = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

function field(block: string, name: string) {
  const value = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim();

  return value && value !== 'N/A' ? value : undefined;
}

/** Exa's text blocks, `Title:`, `URL:`, `Published:` and `Highlights:` or `Text:`, as results. */
export function parseExaResults(text: string): SearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = field(block, 'URL');

    if (!url) return [];

    const title = field(block, 'Title');
    const publishedText = field(block, 'Published');
    const published = publishedText ? Date.parse(publishedText) : Number.NaN;
    const content = /^(?:Highlights|Text):\s*\n?([\s\S]*)$/m.exec(block)?.[1]?.trim();

    return [
      {
        url,
        ...(title ? { title } : {}),
        ...(content ? { content } : {}),
        ...(Number.isFinite(published) ? { published } : {}),
      },
    ];
  });
}

/** Exa's hosted MCP `web_search_exa`, keyless, with a pasted key in `?exaApiKey=`, after OpenCode v2. */
export const exa: SearchProvider = {
  id: 'exa',
  name: 'Exa',
  key: { url: 'https://dashboard.exa.ai/api-keys', hint: 'the Exa dashboard' },
  search: async (query, signal) => {
    const key = await activeKey('exa');
    const url = new URL(endpoint);

    if (key) url.searchParams.set('exaApiKey', key);

    const result = Output.safeParse(
      await mcpCall(url.toString(), 'web_search_exa', { query, numResults: 8 }, {}, signal),
    );

    const text = result.success ? result.data.content.find((item) => item.text)?.text : undefined;

    return text ? parseExaResults(text) : [];
  },
};
