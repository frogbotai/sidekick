// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/" }
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { failure } from './harness';
import { callTool, cancelTool, listTools, MAX_RESULT } from './webmcp';

interface FakeTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  origin: string;
  run?: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}

const TOP = 'https://example.com';

function fakeContext(tools: FakeTool[]) {
  return {
    getTools: vi.fn((_options?: { fromOrigins?: string[] }) => Promise.resolve(tools)),
    executeTool: vi.fn(
      (tool: FakeTool, input: Record<string, unknown>, { signal }: { signal: AbortSignal }) =>
        tool.run ? tool.run(input, signal) : Promise.resolve(`ran ${tool.name}`),
    ),
  };
}

function install(target: object, value: unknown) {
  Object.defineProperty(target, 'modelContext', { value, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext');
  Reflect.deleteProperty(navigator, 'modelContext');
  vi.useRealTimers();
});

const call = (name: string, input = {}, origin = TOP) =>
  callTool({ token: 't1', name, origin, input, fromOrigins: [] });

describe('listTools', () => {
  it('returns an empty list when the browser has no WebMCP', async () => {
    expect(await listTools([])).toEqual({ tools: [], more: 0 });
  });

  it('reads document.modelContext before navigator.modelContext', async () => {
    install(document, fakeContext([{ name: 'doc', description: 'd', origin: TOP }]));
    install(navigator, fakeContext([{ name: 'nav', description: 'n', origin: TOP }]));

    expect((await listTools([])).tools.map(({ name }) => name)).toEqual(['doc']);
  });

  it('falls back to navigator.modelContext', async () => {
    install(navigator, fakeContext([{ name: 'nav', description: 'n', origin: TOP }]));

    expect((await listTools([])).tools.map(({ name }) => name)).toEqual(['nav']);
  });

  it('asks for tools from the given origins, and retries without them if that fails', async () => {
    const context = fakeContext([{ name: 'pay', description: 'p', origin: 'https://pay.test' }]);

    install(document, context);
    await listTools(['https://pay.test']);

    expect(context.getTools).toHaveBeenCalledWith({ fromOrigins: ['https://pay.test'] });

    context.getTools.mockRejectedValueOnce(new DOMException('no', 'SecurityError'));

    expect((await listTools(['https://pay.test'])).tools).toHaveLength(1);
  });

  it('keeps booleans in annotations and passes title and origin through', async () => {
    install(
      document,
      fakeContext([
        {
          name: 'a',
          description: 'd',
          annotations: { readOnlyHint: true, note: 'x' },
          origin: 'https://pay.test',
        },
      ]),
    );

    expect((await listTools([])).tools[0]).toEqual({
      name: 'a',
      description: 'd',
      annotations: { readOnlyHint: true },
      origin: 'https://pay.test',
    });
  });

  it('caps tools at 100, descriptions at 1,000 and schemas at 32,000, marking each cut', async () => {
    const big = { type: 'object', description: 'x'.repeat(40_000) };
    const tools = Array.from({ length: 103 }, (_, index) => ({
      name: `t${index}`,
      description: index === 0 ? 'd'.repeat(1_500) : 'short',
      inputSchema: index === 1 ? big : { type: 'object' },
      origin: TOP,
    }));

    install(document, fakeContext(tools));

    const listed = await listTools([]);

    expect(listed.tools).toHaveLength(100);
    expect(listed.more).toBe(3);
    expect(listed.tools[0]?.description).toHaveLength(1_000);
    expect(listed.tools[0]?.truncated).toBe(true);
    expect(listed.tools[1]?.input_schema).toEqual(expect.any(String));
    expect(String(listed.tools[1]?.input_schema)).toHaveLength(32_000);
    expect(listed.tools[1]?.truncated).toBe(true);
    expect(listed.tools[2]).not.toHaveProperty('truncated');
    expect(listed.tools[2]?.input_schema).toEqual({ type: 'object' });
  });
});

describe('callTool', () => {
  it('runs the tool with the name and origin, and returns its text', async () => {
    const context = fakeContext([
      { name: 'echo', description: 'e', origin: 'https://pay.test' },
      { name: 'echo', description: 'e', origin: TOP, run: (input) => Promise.resolve(input.text) },
    ]);

    install(document, context);

    expect(await call('echo', { text: 'hi' })).toEqual({ result: 'hi', truncated: false });
    expect(context.executeTool.mock.calls[0]?.[0]).toMatchObject({ origin: TOP });
  });

  it('fails invalid_target when the page no longer offers the tool', async () => {
    install(document, fakeContext([{ name: 'echo', description: 'e', origin: TOP }]));

    expect(await failure(call('echo', {}, 'https://pay.test'))).toMatchObject({
      code: 'invalid_target',
    });

    expect(await failure(call('gone'))).toBeInstanceOf(ToolError);
  });

  it('caps the result at 30,000 characters', async () => {
    const long = 'r'.repeat(MAX_RESULT + 5);

    install(
      document,
      fakeContext([
        { name: 'big', description: 'b', origin: TOP, run: () => Promise.resolve(long) },
      ]),
    );

    expect(await call('big')).toEqual({ result: long.slice(0, MAX_RESULT), truncated: true });
  });

  it('returns the message a failing tool throws, as data', async () => {
    install(
      document,
      fakeContext([
        {
          name: 'bad',
          description: 'b',
          origin: TOP,
          run: () => Promise.reject(new Error('Out of stock')),
        },
      ]),
    );

    expect(await call('bad')).toEqual({ error: 'Out of stock' });
  });

  it('times out after 5 seconds and aborts the tool’s signal', async () => {
    vi.useFakeTimers();

    let signal: AbortSignal | undefined;

    install(
      document,
      fakeContext([
        {
          name: 'hang',
          description: 'h',
          origin: TOP,
          run: (_input, given) => {
            signal = given;

            return new Promise(() => undefined);
          },
        },
      ]),
    );

    const pending = failure(call('hang'));

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toMatchObject({ code: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('stops when the worker cancels the call', async () => {
    install(
      document,
      fakeContext([
        { name: 'hang', description: 'h', origin: TOP, run: () => new Promise(() => undefined) },
      ]),
    );

    const pending = failure(call('hang'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelTool('t1');

    expect(await pending).toMatchObject({ code: 'stopped' });
  });
});
