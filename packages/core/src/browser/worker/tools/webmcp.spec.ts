import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILTIN_MODES, PLAN_MODE } from '../../../permission/modes';
import { whollyDenied } from '../../../permission/rules';
import { ToolError, UNTRUSTED } from '../../../tool/tool';
import { fakeTabs } from '../fakes';
import { later } from '../fakes';
import { drain, failure, setupBrowser } from '../harness';
import { chromePage } from '../page';
import type { Page, PageTool } from '../types';

const TOP = 'https://example.com';

const PAY = 'https://pay.test';

const TOOLS: PageTool[] = [
  {
    name: 'add_to_cart',
    description: 'Adds an item',
    input_schema: { type: 'object' },
    annotations: { readOnlyHint: true },
    origin: TOP,
  },
  { name: 'pay', description: 'Pays', origin: PAY },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(page: Partial<Page> = {}) {
  const setup = await setupBrowser({
    page: { webmcpList: later(() => ({ tools: TOOLS, more: 0 })), ...page },
  });

  setup.tabs.frames = later(() => [
    { frameId: 0, parentFrameId: -1, url: `${TOP}/shop` },
    { frameId: 3, parentFrameId: 0, url: `${PAY}/widget` },
    { frameId: 4, parentFrameId: 0, url: 'http://plain.test/ad' },
    { frameId: 5, parentFrameId: 0, url: `${TOP}/same` },
  ]);

  const tool = setup.tool('webmcp');
  const run = (input: Record<string, unknown>) =>
    tool.execute(tool.input.parse({ tab_id: 1, ...input }), setup.ctx);

  return { ...setup, run };
}

describe('webmcp list', () => {
  it('is offered in Plan mode, like snapshot, while call still asks input', async () => {
    const { tool } = await setup();
    const plan = BUILTIN_MODES.find((mode) => mode.id === PLAN_MODE)?.rules ?? [];

    expect(whollyDenied(plan, tool('webmcp').permission)).toBe(false);
    expect(whollyDenied(plan, 'input')).toBe(true);
  });

  it('asks read, passes the secure cross-origin frames, and returns hints as page_hints', async () => {
    const webmcpList = vi.fn(later(() => ({ tools: TOOLS, more: 3 })));
    const { run, ctx } = await setup({ webmcpList });
    const result = await drain(run({ action: 'list' }));

    expect(ctx.asserts).toEqual([{ action: 'read', resource: TOP }]);
    expect(webmcpList).toHaveBeenCalledWith(1, { fromOrigins: [PAY] });
    expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });

    expect(result.output).toEqual({
      url: 'https://example.com/',
      tools: [
        {
          name: 'add_to_cart',
          description: 'Adds an item',
          input_schema: { type: 'object' },
          page_hints: { readOnlyHint: true },
          origin: TOP,
        },
        { name: 'pay', description: 'Pays', origin: PAY },
      ],
      more: 3,
    });
  });
});

describe('webmcp call', () => {
  it('asks input on the top origin, even when the page hints read-only, and returns the result untrusted', async () => {
    const webmcpCall = vi.fn(later(() => ({ result: 'added', truncated: false })));
    const { run, ctx } = await setup({ webmcpCall });

    const result = await drain(run({ action: 'call', tool: 'add_to_cart', input: { sku: 'mug' } }));

    expect(ctx.asserts).toEqual([{ action: 'input', resource: TOP }]);

    expect(webmcpCall).toHaveBeenCalledWith(1, {
      token: expect.any(String),
      name: 'add_to_cart',
      origin: TOP,
      input: { sku: 'mug' },
      fromOrigins: [PAY],
    });

    expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });

    expect(result.output).toEqual({
      url: 'https://example.com/',
      result: 'added',
      truncated: false,
    });

    expect(ctx.reports.at(-1)).toEqual({ target: 'tool “add_to_cart”' });
  });

  it('names the frame’s site for a cross-origin tool', async () => {
    const { run, ctx } = await setup();

    await drain(run({ action: 'call', tool: 'pay' }));

    expect(ctx.asserts).toEqual([
      { action: 'input', resource: TOP },
      { action: 'input', resource: TOP, frameOrigin: PAY },
    ]);
  });

  it('fails invalid_target for a name the page doesn’t offer, without calling', async () => {
    const { run, log } = await setup();
    const error = await failure(run({ action: 'call', tool: 'refund' }));

    expect(error).toMatchObject({
      code: 'invalid_target',
      detail: { tools: ['add_to_cart', 'pay'] },
    });

    expect(log).not.toContain('page.webmcpCall');
  });

  it('fails invalid_target when two sites offer the name, until origin picks one', async () => {
    const twice = [...TOOLS, { name: 'pay', description: 'Also pays', origin: TOP }];
    const { run, ctx } = await setup({ webmcpList: later(() => ({ tools: twice, more: 0 })) });

    expect(await failure(run({ action: 'call', tool: 'pay' }))).toMatchObject({
      code: 'invalid_target',
      detail: { origins: [PAY, TOP] },
    });

    ctx.asserts.length = 0;
    await drain(run({ action: 'call', tool: 'pay', origin: TOP }));

    expect(ctx.asserts).toEqual([{ action: 'input', resource: TOP }]);
  });

  it('fails invalid_target without a tool name', async () => {
    const { run } = await setup();

    expect(await failure(run({ action: 'call' }))).toMatchObject({ code: 'invalid_target' });
  });

  it('passes the page’s timeout through', async () => {
    const { run } = await setup({
      webmcpCall: () => Promise.reject(new ToolError('timeout', 'late')),
    });

    expect(await failure(run({ action: 'call', tool: 'add_to_cart' }))).toMatchObject({
      code: 'timeout',
    });
  });

  it('cancels the call in the page and ends stopped when the run is aborted', async () => {
    const webmcpCancel = vi.fn(later(() => undefined));
    const { run, ctx } = await setup({
      webmcpCall: () => new Promise(() => undefined),
      webmcpCancel,
    });

    const pending = failure(run({ action: 'call', tool: 'add_to_cart' }));

    await vi.advanceTimersByTimeAsync(10);
    ctx.controller.abort();

    expect(await pending).toMatchObject({ code: 'stopped' });
    expect(webmcpCancel).toHaveBeenCalledWith(1, expect.any(String));
  });
});

describe('webmcp over the page', () => {
  it('sends a call once, never again into the next document, when the page navigates mid-call', async () => {
    const sendMessage = vi.fn(() =>
      Promise.reject(new Error('The message port closed before a response was received.')),
    );

    const inject = vi.fn(() => Promise.resolve());

    vi.stubGlobal('chrome', { tabs: { sendMessage } });

    try {
      const page = chromePage({ tabs: fakeTabs([], []), inject });
      const call = { token: 't1', name: 'add_to_cart', origin: TOP, input: {}, fromOrigins: [] };

      await page.webmcpCall(1, call).catch(() => undefined);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(inject).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
