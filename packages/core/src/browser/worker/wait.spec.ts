import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { MAX_WAIT_MS, WAIT_TIMEOUT_MS } from './tools/page';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function removed() {
  return new ToolError('stale_ref', 'f0e1 is no longer on the page.', { reason: 'removed' });
}

describe('wait_for conditions (sidekick-17 req. 8-13)', () => {
  it('returns once text appears, polling until then', async () => {
    let probes = 0;
    const { tool, ctx } = await setupBrowser({ page: { hasText: later(() => ++probes >= 4) } });

    const { output } = await drain(tool('wait_for').execute({ tab_id: 1, text: 'Done' }, ctx));

    expect(probes).toBe(4);
    expect(output).toEqual({ url: 'https://example.com/', waited_ms: 750 });
  });

  it('waits for text to go away, and keeps polling through a page that can’t answer', async () => {
    const answers: (boolean | Error)[] = [true, new ToolError('unsupported_page', 'x'), false];
    const { tool, ctx } = await setupBrowser({
      page: {
        hasText: later(() => {
          const next = answers.shift();

          if (next instanceof Error) throw next;

          return next ?? false;
        }),
      },
    });

    await drain(tool('wait_for').execute({ tab_id: 1, text_gone: 'Loading' }, ctx));

    expect(answers).toEqual([]);
  });

  it('matches a substring of the tab’s URL', async () => {
    const setup = await setupBrowser();
    const waiting = setup.tool('wait_for').execute({ tab_id: 1, url: '/checkout/done' }, setup.ctx);

    await vi.advanceTimersByTimeAsync(600);

    const tab = setup.tabs.tabs.get(1);

    if (tab) tab.url = 'https://example.com/checkout/done?id=4';

    const { output } = await drain(waiting);

    expect(output).toMatchObject({ url: 'https://example.com/checkout/done?id=4' });
  });

  it('uses waitForLoad for load, with the timeout', async () => {
    const waitForLoad = vi.fn((_tabId: number, _timeout: number) => true);
    const { tool, ctx, tabs } = await setupBrowser();

    tabs.waitForLoad = later(waitForLoad);

    await drain(tool('wait_for').execute({ tab_id: 1, load: true, timeout_ms: 5_000 }, ctx));

    expect(waitForLoad).toHaveBeenCalledWith(1, 5_000);
  });

  it('waits for a ref to show', async () => {
    let probes = 0;
    const { tool, ctx } = await setupBrowser({ page: { isVisible: later(() => ++probes > 1) } });

    await drain(tool('wait_for').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(probes).toBe(2);
  });

  it('counts a ref the page removed while waiting for hidden as hidden', async () => {
    let probes = 0;
    const { tool, ctx } = await setupBrowser({
      page: {
        isVisible: later(() => {
          if (++probes > 1) throw removed();

          return true;
        }),
      },
    });

    const { output } = await drain(
      tool('wait_for').execute({ tab_id: 1, ref: 'f0e1', state: 'hidden' }, ctx),
    );

    expect(output).toMatchObject({ waited_ms: 250 });
  });

  it('fails stale_ref, not timeout, when the ref is stale from the start and it waits to show it', async () => {
    const { tool, ctx } = await setupBrowser({
      page: {
        inspect: later(() => {
          throw removed();
        }),
      },
    });

    const error = await failure(tool('wait_for').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(error).toMatchObject({ code: 'stale_ref' });
  });

  it('returns at once for hidden when the page already removed the element', async () => {
    const gone = later(() => {
      throw removed();
    });

    const { tool, ctx } = await setupBrowser({ page: { inspect: gone, isVisible: gone } });

    const { output } = await drain(
      tool('wait_for').execute({ tab_id: 1, ref: 'f0e1', state: 'hidden' }, ctx),
    );

    expect(output).toMatchObject({ waited_ms: 0 });
  });

  it('fails stale_ref when the page navigates mid-wait', async () => {
    let probes = 0;
    const { tool, ctx } = await setupBrowser({
      page: {
        isVisible: later(() => {
          if (++probes > 1) {
            throw new ToolError('stale_ref', 'navigated', { reason: 'navigated' });
          }

          return true;
        }),
      },
    });

    const error = await failure(
      tool('wait_for').execute({ tab_id: 1, ref: 'f0e1', state: 'hidden' }, ctx),
    );

    expect(error).toMatchObject({ code: 'stale_ref', detail: { reason: 'navigated' } });
  });
});

describe('wait_for limits (sidekick-17 req. 8, 10, 11)', () => {
  it('fails timeout after 10 s by default, saying what it waited for', async () => {
    const { tool, ctx } = await setupBrowser({ page: { hasText: later(() => false) } });
    const waiting = failure(tool('wait_for').execute({ tab_id: 1, text: 'Order placed' }, ctx));

    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS - 500);

    const error = await waiting;

    expect(error).toMatchObject({
      code: 'timeout',
      message: /^Waited 10 s for text “Order placed” to appear/,
    });
  });

  it('refuses text made only of spaces, which every page contains', async () => {
    const { tool } = await setupBrowser();
    const { input } = tool('wait_for');

    expect(input.safeParse({ tab_id: 1, text: '   ' }).success).toBe(false);
    expect(input.safeParse({ tab_id: 1, text_gone: '\n ' }).success).toBe(false);
  });

  it('caps timeout_ms at 30 s', async () => {
    const { tool } = await setupBrowser();
    const { input } = tool('wait_for');

    expect(input.safeParse({ tab_id: 1, text: 'x', timeout_ms: MAX_WAIT_MS }).success).toBe(true);

    expect(input.safeParse({ tab_id: 1, text: 'x', timeout_ms: MAX_WAIT_MS + 1 }).success).toBe(
      false,
    );
  });

  it.each([
    [{}, /gave none/],
    [{ text: 'a', url: 'b' }, /gave text and url/],
    [{ text: 'a', state: 'hidden' }, /state goes with ref/],
  ])('refuses %o', async (conditions, message) => {
    const { tool, ctx } = await setupBrowser();

    const error = await failure(tool('wait_for').execute({ tab_id: 1, ...conditions }, ctx));

    expect(error).toMatchObject({ code: 'invalid_target', message });
  });

  it('stops at once when the run is aborted', async () => {
    const { tool, ctx } = await setupBrowser({ page: { hasText: later(() => false) } });
    const waiting = failure(tool('wait_for').execute({ tab_id: 1, text: 'x' }, ctx));

    await vi.advanceTimersByTimeAsync(300);
    ctx.controller.abort();

    expect(await waiting).toMatchObject({ code: 'stopped' });
  });

  it('asks for read permission', async () => {
    const { tool } = await setupBrowser();

    expect(tool('wait_for').permission).toBe('read');
  });
});
