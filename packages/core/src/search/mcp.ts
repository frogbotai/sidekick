import { z } from 'zod';

import { ToolError } from '../tool/tool';
import { searchFetch } from './http';

const Message = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const Failed = z.object({
  isError: z.literal(true),
  content: z.array(z.object({ text: z.string().optional() })).optional(),
});

function message(payload: string) {
  const trimmed = payload.trim();

  if (!trimmed.startsWith('{')) return undefined;

  try {
    const parsed = Message.safeParse(JSON.parse(trimmed));

    return parsed.success && (parsed.data.result !== undefined || parsed.data.error)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON-RPC message in a JSON body, or in the first SSE `data:` line that parses, after OpenCode v2's `parseResponse`. */
export function parseMcpResponse(body: string) {
  const direct = message(body);

  if (direct) return direct;

  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;

    const parsed = message(line.slice(6));

    if (parsed) return parsed;
  }

  return undefined;
}

/**
 * One stateless MCP `tools/call` with no `initialize`, after OpenCode v2's `WebSearchMcp.call`.
 * Returns the tool's `result`, or `undefined` when the body holds no JSON-RPC answer. A JSON-RPC
 * `error` or an `isError` result fails with the server's text.
 */
export async function mcpCall(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  const body = await searchFetch(
    url,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
    },
    signal,
    tool,
  );

  const response = parseMcpResponse(body);

  if (response?.error) {
    throw new ToolError('request_failed', `${tool} failed: ${response.error.message}`);
  }

  const failed = Failed.safeParse(response?.result);

  if (failed.success) {
    const text = (failed.data.content ?? [])
      .map((item) => item.text?.trim())
      .filter(Boolean)
      .join('\n');

    throw new ToolError('request_failed', `${tool} failed: ${text || 'unknown error'}`);
  }

  return response?.result;
}
