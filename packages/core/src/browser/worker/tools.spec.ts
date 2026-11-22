import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BUILTIN_MODES, PLAN_MODE } from '../../permission/modes';
import { whollyDenied } from '../../permission/rules';
import { tools } from '../../registry';
import { createToolCaller } from '../../tool/bridge';
import { defineTool, type ToolDefinition, ToolError, UNTRUSTED } from '../../tool/tool';
import { MAX_BASELINES } from './baselines';
import { later, solid } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { MAX_CHARS_CAP } from './tools/read';

type Setup = Awaited<ReturnType<typeof setupBrowser>>;

const SAMPLES: Record<
  string,
  { input: Record<string, unknown>; resource: string; before?: (setup: Setup) => Promise<unknown> }
> = {
  tabs_list: { input: {}, resource: '*' },
  tabs_open: { input: { url: 'new.test/a' }, resource: 'https://new.test' },
  tabs_switch: { input: { tab_id: 1 }, resource: 'https://example.com' },
  tabs_close: { input: { tab_id: 1 }, resource: 'https://example.com' },
  navigate: { input: { tab_id: 1, url: 'https://next.test/' }, resource: 'https://next.test' },
  snapshot: { input: { tab_id: 1 }, resource: 'https://example.com' },
  page_text: { input: { tab_id: 1 }, resource: 'https://example.com' },
  screenshot: { input: { tab_id: 1 }, resource: 'https://example.com' },
  screenshot_diff: {
    input: { tab_id: 1, baseline: 'before' },
    resource: 'https://example.com',
    before: ({ tool, ctx }) =>
      drain(tool('screenshot').execute({ tab_id: 1, name: 'before' }, ctx)),
  },
  scroll: { input: { tab_id: 1, direction: 'down' }, resource: 'https://example.com' },
  scroll_to: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  record_start: { input: { tab_id: 1 }, resource: 'https://example.com' },
  record_status: {
    input: { tab_id: 1 },
    resource: 'https://example.com',
    before: ({ tool, ctx }) => drain(tool('record_start').execute({ tab_id: 1 }, ctx)),
  },
  record_stop: {
    input: { tab_id: 1 },
    resource: 'https://example.com',
    before: ({ tool, ctx }) => drain(tool('record_start').execute({ tab_id: 1 }, ctx)),
  },
  click: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  hover: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  fill: { input: { tab_id: 1, ref: 'f0e1', text: 'hi' }, resource: 'https://example.com' },
  type: { input: { tab_id: 1, text: 'hi' }, resource: 'https://example.com' },
  check: { input: { tab_id: 1, ref: 'f0e1', checked: false }, resource: 'https://example.com' },
  select: { input: { tab_id: 1, ref: 'f0e1', values: ['a'] }, resource: 'https://example.com' },
  press: { input: { tab_id: 1, key: 'Enter' }, resource: 'https://example.com' },
  drag: { input: { tab_id: 1, from: 'f0e1', to: 'f0e2' }, resource: 'https://example.com' },
  wait_for: { input: { tab_id: 1, text: 'Done' }, resource: 'https://example.com' },
  eval: { input: { tab_id: 1, script: 'document.title' }, resource: 'https://example.com' },
  emulate: { input: { tab_id: 1, color_scheme: 'dark' }, resource: 'https://example.com' },
  webmcp: { input: { tab_id: 1, action: 'list' }, resource: 'https://example.com' },
};

const disposers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();

  vi.useRealTimers();
});

function bad(id: string, input: z.ZodType = z.object({})): ToolDefinition {
  return defineTool({
    id,
    description: 'bad',
    input,
    output: z.object({}),
    permission: 'read',
    execute: () => Promise.resolve({ output: {} }),
  });
}

describe('browser tools in the tools registry', () => {
  it('registers all 24, and sends a bad id or schema to errors()', async () => {
    const { runtime } = await setupBrowser();

    disposers.push(
      tools.register('builtin', (draft) => {
        for (const tool of runtime.tools) draft.add(tool);

        draft.add(bad('browser.click'));
        draft.add(bad('x'.repeat(65)));
        draft.add(bad('when', z.object({ at: z.date() })));
        draft.add(bad('text', z.string()));
      }),
    );

    expect(tools.list().map(({ id }) => id)).toEqual(Object.keys(SAMPLES));
    expect(tools.errors()).toHaveLength(4);
    expect(tools.errors().every(({ source }) => source === 'builtin')).toBe(true);
  });

  it.each(Object.entries(SAMPLES))(
    '%s asserts its action and resource before anything else',
    async (id, { input, resource, before }) => {
      const setup = await setupBrowser();
      const { tool, ctx, log } = setup;

      await before?.(setup);
      log.length = 0;
      ctx.asserts.length = 0;

      const definition = tool(id);
      const result = await drain(definition.execute(definition.input.parse(input), ctx));

      expect(log.find((entry) => entry !== 'tabs.get')).toBe(`assert.${definition.permission}`);
      expect(ctx.asserts[0]).toEqual({ action: definition.permission, resource });
      expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });
    },
  );

  it.each([
    'snapshot',
    'page_text',
    'screenshot',
    'scroll',
    'scroll_to',
    'tabs_switch',
    'tabs_close',
    'click',
    'webmcp',
  ])('%s fails navigated when the tab changes site during its assert', async (id) => {
    const { tool, ctx, tabs } = await setupBrowser();
    const definition = tool(id);
    const sample = SAMPLES[id];

    if (!sample) throw new Error(`No sample for ${id}`);

    ctx.permission.assert = later(() => {
      const tab = tabs.tabs.get(1);

      if (tab) tab.url = 'https://elsewhere.test/';
    });

    const error = await failure(definition.execute(definition.input.parse(sample.input), ctx));

    expect(error).toMatchObject({ code: 'navigated' });
  });
});

describe('Plan mode (sidekick-17 acceptance 6)', () => {
  it('denies type, eval and emulate and keeps wait_for', async () => {
    const { runtime } = await setupBrowser();
    const plan = BUILTIN_MODES.find(({ id }) => id === PLAN_MODE);
    const offered = runtime.tools
      .filter(({ permission }) => !whollyDenied(plan?.rules ?? [], permission))
      .map(({ id }) => id);

    expect(offered).toContain('wait_for');
    expect(offered).not.toContain('type');
    expect(offered).not.toContain('eval');
    expect(offered).not.toContain('emulate');
  });
});

function callerOf({ runtime, run }: Awaited<ReturnType<typeof setupBrowser>>) {
  const caller = createToolCaller({
    tools: {
      list: () => runtime.tools,
      get: (id) => runtime.tools.find((entry) => entry.id === id),
    },
    permission: {
      assert: () => Promise.resolve(),
      reply: () => Promise.resolve(),
      list: () => [],
      cancel: () => undefined,
    },
  });

  let next = 0;

  return (tool: string, input: unknown) =>
    caller.call(
      { tool, input, sessionID: 'ses-1', messageID: 'msg-1', callID: `c${next++}`, agent: 'build' },
      { run: () => Promise.resolve({ id: run.id }) },
    );
}

describe('navigate waits for the new page (331 req. 2, 3)', () => {
  it('resolves only after the main frame commits', async () => {
    const { tool, ctx, tabs } = await setupBrowser();
    let done = false;

    tabs.navigation = 'none';

    const navigate = tool('navigate')
      .execute({ tab_id: 1, url: 'https://next.test/' }, ctx)
      .finally(() => (done = true));

    await vi.advanceTimersByTimeAsync(2_000);

    expect(done).toBe(false);

    tabs.commit({ tabId: 1 });

    const { output } = await drain(navigate);

    expect(output).toEqual({ url: 'https://next.test/', navigated: true, settled: true });
  });

  it('fails with Chrome’s error text when the main frame fails to load', async () => {
    const { tool, ctx, tabs } = await setupBrowser();

    tabs.navigation = { error: 'net::ERR_NAME_NOT_RESOLVED' };

    const error = await failure(tool('navigate').execute({ tab_id: 1, url: 'nowhere.test' }, ctx));

    expect(error).toMatchObject({
      code: 'request_failed',
      message: 'The page didn’t load: net::ERR_NAME_NOT_RESOLVED.',
    });
  });

  it('gives settled: false and the current URL without a commit, skipping the quiet wait', async () => {
    const { tool, ctx, tabs, log } = await setupBrowser();

    tabs.navigation = 'none';

    const { output } = await drain(tool('navigate').execute({ tab_id: 1, go: 'reload' }, ctx));

    expect(output).toEqual({ url: 'https://example.com/', navigated: false, settled: false });
    expect(log).not.toContain('page.domQuiet');
  });

  it('reloads the same URL and says navigated: true', async () => {
    const { tool, ctx, log } = await setupBrowser();

    const { output } = await drain(
      tool('navigate').execute({ tab_id: 1, url: 'https://example.com/' }, ctx),
    );

    expect(output).toEqual({ url: 'https://example.com/', navigated: true, settled: true });
    expect(log.filter((entry) => entry === 'tabs.navigate')).toHaveLength(1);
  });

  it('runs two same-URL navigates in one step one after another, each with its own update', async () => {
    const setup = await setupBrowser();
    const call = callerOf(setup);

    const both = Promise.all([
      call('navigate', { tab_id: 1, url: 'https://example.com/' }),
      call('navigate', { tab_id: 1, url: 'https://example.com/' }),
    ]);

    const results = await drain(both);

    expect(results).toEqual([
      { ok: expect.objectContaining({ output: expect.objectContaining({ navigated: true }) }) },
      { ok: expect.objectContaining({ output: expect.objectContaining({ navigated: true }) }) },
    ]);

    expect(setup.log.filter((entry) => entry === 'tabs.navigate')).toHaveLength(2);
  });

  it('waits for a navigation already pending to the same URL instead of starting another', async () => {
    const { tool, ctx, tabs, log } = await setupBrowser();
    const tab = tabs.tabs.get(1);

    if (tab) tab.pendingUrl = 'https://example.com/next';

    const navigate = tool('navigate').execute({ tab_id: 1, url: 'https://example.com/next' }, ctx);

    await vi.advanceTimersByTimeAsync(100);

    if (tab) {
      tab.url = 'https://example.com/next';
      delete tab.pendingUrl;
    }

    tabs.commit({ tabId: 1 });

    const { output } = await drain(navigate);

    expect(output).toEqual({ url: 'https://example.com/next', navigated: true, settled: true });
    expect(log).not.toContain('tabs.navigate');
  });
});

describe('snapshot limits (331 req. 5)', () => {
  it('clamps max_chars to 1,000 and the cap instead of refusing it', async () => {
    const asked: number[] = [];
    const { tool, ctx } = await setupBrowser({
      page: {
        snapshot: later((_tabId: number, { max_chars }: { max_chars: number }) => {
          asked.push(max_chars);

          return { title: 'Example', text: '', redacted: 0, truncated: false };
        }),
      },
    });

    const snapshot = tool('snapshot');

    for (const max_chars of [300, 1e9]) {
      await drain(snapshot.execute(snapshot.input.parse({ tab_id: 1, max_chars }), ctx));
    }

    expect(asked).toEqual([1_000, MAX_CHARS_CAP]);
  });

  it('reports the URL the tab is on after the read', async () => {
    const setup = await setupBrowser({
      page: {
        snapshot: later(() => {
          const tab = setup.tabs.tabs.get(1);

          if (tab) tab.url = 'https://example.com/after';

          return { title: 'Example', text: '', redacted: 0, truncated: false };
        }),
      },
    });

    const { output } = await drain(setup.tool('snapshot').execute({ tab_id: 1 }, setup.ctx));

    expect(output).toMatchObject({ url: 'https://example.com/after' });
  });
});

describe('screenshot_diff against a named baseline (sidekick-19 req. 7, 8, 10)', () => {
  async function diffed(setup: Setup, input: Record<string, unknown> = {}) {
    const diff = setup.tool('screenshot_diff');

    return drain(
      diff.execute(diff.input.parse({ tab_id: 1, baseline: 'before', ...input }), setup.ctx),
    );
  }

  async function baseline(setup: Setup, input: Record<string, unknown> = {}) {
    await drain(
      setup.tool('screenshot').execute({ tab_id: 1, name: 'before', ...input }, setup.ctx),
    );
  }

  it('returns zero changed pixels and a gray PNG when nothing changed', async () => {
    const setup = await setupBrowser();

    await baseline(setup);

    const result = await diffed(setup);

    expect(result.output).toEqual({
      url: 'https://example.com/',
      width: 800,
      height: 600,
      changed_pixels: 0,
      changed_share: 0,
    });

    expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });

    expect(result.content?.[1]).toEqual({
      type: 'file',
      uri: `data:image/png;base64,${btoa('png 800x600')}`,
      mime: 'image/png',
      name: 'diff',
    });

    expect(setup.images.encoded[0]?.data.slice(0, 4)).not.toEqual(
      new Uint8ClampedArray([255, 0, 0, 255]),
    );
  });

  it('counts the pixels that changed since the baseline and marks them red', async () => {
    const setup = await setupBrowser();

    setup.images.paint = (index, size) => {
      const image = solid(size, [255, 255, 255, 255]);

      if (index === 1) {
        for (let pixel = 0; pixel < 100; pixel++) image.data.set([0, 0, 0, 255], pixel * 4);
      }

      return image;
    };

    await baseline(setup);

    const result = await diffed(setup);

    expect(result.output).toMatchObject({ changed_pixels: 100, changed_share: 0.000208 });
    expect([...(setup.images.encoded[0]?.data.slice(0, 4) ?? [])]).toEqual([255, 0, 0, 255]);
  });

  it('captures again with the baseline’s scale and element', async () => {
    const setup = await setupBrowser();

    await baseline(setup, { scale: 0.5, ref: 'f0e1' });
    setup.cdp.sent.length = 0;

    const result = await diffed(setup);
    const clip = setup.cdp.sent.find(({ method }) => method === 'Page.captureScreenshot')?.params
      .clip;

    expect(clip).toMatchObject({ width: 100, height: 100, scale: 0.5 });
    expect(result.output).toMatchObject({ width: 50, height: 50 });
  });

  it('refuses a capture of another size, telling the agent to keep the viewport', async () => {
    const setup = await setupBrowser();

    await baseline(setup);

    setup.cdp.replies.set('Page.getLayoutMetrics', () => ({
      cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 700, clientHeight: 600 },
      visualViewport: { clientWidth: 700 },
    }));

    const error = await failure(diffed(setup));

    expect(error).toMatchObject({
      code: 'size_mismatch',
      message: expect.stringContaining('baseline 800×600, now 700×600'),
    });

    expect(setup.images.encoded).toHaveLength(0);
  });

  it('says a missing baseline is gone and how to take it', async () => {
    const setup = await setupBrowser();

    const error = await failure(diffed(setup, { baseline: 'never' }));

    expect(error).toMatchObject({
      code: 'no_baseline',
      message: expect.stringContaining('Take one with screenshot and name “never”'),
    });
  });

  it('keeps only the newest baselines, replacing one taken again under its name', async () => {
    const setup = await setupBrowser();

    for (let index = 0; index <= MAX_BASELINES; index++) {
      await baseline(setup, { name: `b${index}` });
    }

    expect(await failure(diffed(setup, { baseline: 'b0' }))).toMatchObject({ code: 'no_baseline' });

    expect((await diffed(setup, { baseline: `b${MAX_BASELINES}` })).output).toMatchObject({
      changed_pixels: 0,
    });
  });

  it('reports a nonzero share when one pixel changed', async () => {
    const setup = await setupBrowser();

    setup.images.paint = (index, size) => {
      const image = solid(size, [255, 255, 255, 255]);

      if (index === 1) image.data.set([0, 0, 0, 255], 0);

      return image;
    };

    await baseline(setup);

    expect((await diffed(setup)).output).toMatchObject({
      changed_pixels: 1,
      changed_share: 0.00000208,
    });
  });

  it.each([
    ['refused for its size', true],
    ['made', false],
  ])(
    'keeps stale_screenshot after a navigation and a diff %s (271 D2)',
    async (outcome, resize) => {
      const setup = await setupBrowser();

      await baseline(setup, { scale: 0.5 });
      setup.tabs.commit({ tabId: 1 });

      if (resize) {
        setup.cdp.replies.set('Page.getLayoutMetrics', () => ({
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 700, clientHeight: 600 },
          visualViewport: { clientWidth: 700 },
        }));
      }

      const diff = await diffed(setup).then(
        () => 'made',
        (error: unknown) => (error instanceof ToolError ? error.code : String(error)),
      );

      expect(diff).toBe(outcome === 'made' ? 'made' : 'size_mismatch');

      const click = setup.tool('click').execute({ tab_id: 1, x: 100, y: 50 }, setup.ctx);

      expect(await failure(click)).toMatchObject({ code: 'stale_screenshot' });
    },
  );

  it('refuses a threshold outside 0 to 1 at the schema', async () => {
    const { tool } = await setupBrowser();

    expect(
      tool('screenshot_diff').input.safeParse({ tab_id: 1, baseline: 'a', threshold: 2 }).success,
    ).toBe(false);
  });
});
