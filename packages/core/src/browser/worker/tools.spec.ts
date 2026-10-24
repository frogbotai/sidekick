import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { tools } from '../../registry';
import { createToolCaller } from '../../tool/bridge';
import { defineTool, type ToolDefinition, UNTRUSTED } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { MAX_CHARS_CAP } from './tools/read';

const SAMPLES: Record<string, { input: Record<string, unknown>; resource: string }> = {
  tabs_list: { input: {}, resource: '*' },
  tabs_open: { input: { url: 'new.test/a' }, resource: 'https://new.test' },
  tabs_switch: { input: { tab_id: 1 }, resource: 'https://example.com' },
  tabs_close: { input: { tab_id: 1 }, resource: 'https://example.com' },
  navigate: { input: { tab_id: 1, url: 'https://next.test/' }, resource: 'https://next.test' },
  snapshot: { input: { tab_id: 1 }, resource: 'https://example.com' },
  screenshot: { input: { tab_id: 1 }, resource: 'https://example.com' },
  scroll: { input: { tab_id: 1, direction: 'down' }, resource: 'https://example.com' },
  scroll_to: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  click: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  hover: { input: { tab_id: 1, ref: 'f0e1' }, resource: 'https://example.com' },
  fill: { input: { tab_id: 1, ref: 'f0e1', text: 'hi' }, resource: 'https://example.com' },
  check: { input: { tab_id: 1, ref: 'f0e1', checked: false }, resource: 'https://example.com' },
  select: { input: { tab_id: 1, ref: 'f0e1', values: ['a'] }, resource: 'https://example.com' },
  press: { input: { tab_id: 1, key: 'Enter' }, resource: 'https://example.com' },
  drag: { input: { tab_id: 1, from: 'f0e1', to: 'f0e2' }, resource: 'https://example.com' },
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
  it('registers all 15, and sends a bad id or schema to errors()', async () => {
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
    async (id, { input, resource }) => {
      const { tool, ctx, log } = await setupBrowser();
      const definition = tool(id);
      const result = await drain(definition.execute(definition.input.parse(input), ctx));

      expect(log.find((entry) => entry !== 'tabs.get')).toBe(`assert.${definition.permission}`);
      expect(ctx.asserts[0]).toEqual({ action: definition.permission, resource });
      expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });
    },
  );

  it.each(['snapshot', 'screenshot', 'scroll', 'scroll_to', 'tabs_switch', 'tabs_close', 'click'])(
    '%s fails navigated when the tab changes site during its assert',
    async (id) => {
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
    },
  );
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
