import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../tool/tool';
import { mcpCall, parseMcpResponse } from './mcp';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

const RESULT = { content: [{ type: 'text', text: 'hi' }] };

const call = () =>
  mcpCall(
    'https://mcp.example/mcp',
    'search_tool',
    { query: 'q' },
    { Authorization: 'Bearer k' },
    new AbortController().signal,
  );

beforeEach(() => {
  network.mockReset();
});

describe('parseMcpResponse', () => {
  it('reads a JSON body', () => {
    expect(parseMcpResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: RESULT }))).toEqual(
      expect.objectContaining({ result: RESULT }),
    );
  });

  it('reads the first SSE data line that parses', () => {
    const body = [
      'event: message',
      'data: not json',
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: RESULT })}`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { other: true } })}`,
    ].join('\n');

    expect(parseMcpResponse(body)?.result).toEqual(RESULT);
  });

  it('returns undefined for a body with no answer', () => {
    expect(parseMcpResponse('')).toBeUndefined();
    expect(parseMcpResponse('event: ping\n\n')).toBeUndefined();
  });
});

describe('mcpCall', () => {
  it('posts one tools/call with no initialize, accepting JSON or SSE', async () => {
    network.mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1, result: RESULT }));

    expect(await call()).toEqual(RESULT);
    expect(network).toHaveBeenCalledTimes(1);

    const [url, init] = network.mock.calls[0] ?? [];

    expect(url).toBe('https://mcp.example/mcp');
    expect(init?.method).toBe('POST');

    expect(init?.headers).toEqual({
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: 'Bearer k',
    });

    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_tool', arguments: { query: 'q' } },
    });
  });

  it('fails with the server text on a JSON-RPC error', async () => {
    network.mockResolvedValue(
      Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad query' } }),
    );

    const error = await call().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolError);

    expect(error).toMatchObject({
      code: 'request_failed',
      message: 'search_tool failed: bad query',
    });
  });

  it('fails with the server text on an isError result, instead of no results', async () => {
    network.mockResolvedValue(
      new Response(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] },
        })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    await expect(call()).rejects.toMatchObject({ message: 'search_tool failed: quota exceeded' });
  });

  it('returns undefined when the body holds no answer', async () => {
    network.mockResolvedValue(new Response(''));

    expect(await call()).toBeUndefined();
  });
});
