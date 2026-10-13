import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { stripExtensionFrames } from './strip';

const EXTENSION_FRAME = new Error('Cannot access a chrome-extension:// URL of different extension');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function reasonOf(error: unknown) {
  return error instanceof ToolError ? [error.code, error.detail?.reason] : error;
}

async function blocking() {
  return setupBrowser({
    page: {
      iframes: later(() => [
        { frameId: 0, sources: ['https://ads.test/slot', 'chrome-extension://abcdef/inject.html'] },
      ]),
      strip: later(() => ['chrome-extension://abcdef/inject.html']),
    },
  });
}

describe('debugger sessions (req. 2, 21)', () => {
  it('attaches on first use and reuses the session', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));
    await drain(tool('hover').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(cdp.attaching).toEqual([1]);
    expect(cdp.sent.filter(({ method }) => method === 'Network.enable')).toHaveLength(1);
  });

  it('does not attach for reads that don’t need the debugger', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('snapshot').execute({ tab_id: 1 }, ctx));
    await drain(tool('scroll_to').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(cdp.attaching).toEqual([]);
  });

  it('detaches 20 s after the last command, and attaches again on the next', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx), 10, 100);
    await vi.advanceTimersByTimeAsync(19_000);

    expect(cdp.detached).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(cdp.detached).toEqual([1]);

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(cdp.attaching).toEqual([1, 1]);
  });

  it('detaches leftover sessions on start', async () => {
    const { runtime, cdp } = await setupBrowser();

    cdp.leftover.push(5, 9);
    await runtime.start();

    expect(cdp.detached).toEqual([5, 9]);
  });

  it.each([
    ['Another debugger is already attached to the tab with id: 1.', 'devtools_open'],
    ['Cannot access a chrome:// URL', 'restricted_url'],
    ['Host access is restricted by policy.', 'policy'],
  ])('maps "%s" to attach_blocked %s', async (message, reason) => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.attachErrors.push(new Error(message));

    expect(reasonOf(await failure(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx)))).toEqual(
      ['attach_blocked', reason],
    );
  });

  it('gives devtools_open when attach hangs', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.attach = () => new Promise<void>(() => undefined);

    expect(reasonOf(await failure(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx)))).toEqual(
      ['attach_blocked', 'devtools_open'],
    );
  });
});

describe('another extension’s frame (271 D1)', () => {
  it('strips the foreign frame, reports it, and retries the attach', async () => {
    const { tool, ctx, cdp, runtime, log } = await blocking();
    const stripped: unknown[] = [];

    runtime.env.sessions.onStripped((event) => stripped.push(event));
    cdp.attachErrors.push(EXTENSION_FRAME);

    const result = await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(result.output).toMatchObject({ settled: true });
    expect(cdp.attaching).toEqual([1, 1]);
    expect(log).toContain('page.strip');
    expect(stripped).toEqual([{ tabId: 1, removed: ['chrome-extension://abcdef'] }]);
  });

  it('passes the reported frames’ origins and the surplus to the strip', async () => {
    const { tool, ctx, cdp, tabs, page } = await blocking();
    const strip = vi.spyOn(page, 'strip');

    tabs.frames = later(() => [
      { frameId: 0, parentFrameId: -1, url: 'https://example.com/' },
      { frameId: 3, parentFrameId: 0, url: 'https://ads.test/slot' },
    ]);

    cdp.attachErrors.push(EXTENSION_FRAME);
    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(strip).toHaveBeenCalledWith(1, 0, { reported: ['https://ads.test'], surplus: 1 });
  });

  it('retries 4 times at 75 ms × n, then throws attach_blocked other_extension', async () => {
    const { tool, ctx, cdp } = await blocking();

    cdp.attachErrors.push(...Array(5).fill(EXTENSION_FRAME));

    const click = tool('click')
      .execute({ tab_id: 1, ref: 'f0e1' }, ctx)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(74);

    expect(cdp.attaching).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(cdp.attaching).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(150 + 225 + 300);

    expect(cdp.attaching).toHaveLength(5);
    expect(reasonOf(await click)).toEqual(['attach_blocked', 'other_extension']);
  });

  it('tries one re-attach when nothing is removable', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.attachErrors.push(EXTENSION_FRAME, EXTENSION_FRAME);

    expect(reasonOf(await failure(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx)))).toEqual(
      ['attach_blocked', 'other_extension'],
    );

    expect(cdp.attaching).toHaveLength(2);
  });

  it('leaves the page alone when the kill switch is off', async () => {
    const { tool, ctx, cdp, log } = await blocking();

    await stripExtensionFrames.set(false);
    cdp.attachErrors.push(EXTENSION_FRAME);

    expect(reasonOf(await failure(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx)))).toEqual(
      ['attach_blocked', 'other_extension'],
    );

    expect(cdp.attaching).toHaveLength(1);
    expect(log).not.toContain('page.strip');
  });

  it('strips and re-attaches when the frame ends a session mid-run', async () => {
    const { tool, ctx, cdp, log } = await blocking();
    let first = true;

    cdp.replies.set('Input.dispatchMouseEvent', () => {
      if (!first) return {};

      first = false;
      cdp.detachByChrome(1, 'target_closed');

      throw EXTENSION_FRAME;
    });

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));
    cdp.attachErrors.push(EXTENSION_FRAME);

    first = true;
    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(cdp.attaching).toEqual([1, 1, 1, 1]);
    expect(log.filter((entry) => entry === 'page.strip')).toHaveLength(1);
  });
});

describe('the infobar’s Cancel (271 D2)', () => {
  it('drops the session, keeps the run, and re-attaches on the next command', async () => {
    const { tool, ctx, cdp, runtime, run } = await setupBrowser();

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));
    cdp.detachByChrome(1, 'canceled_by_user');

    expect(runtime.env.runs.get(run.id)).toBeDefined();
    expect(runtime.env.sessions.attached(1)).toBe(false);

    const result = await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(result.output).toMatchObject({ settled: true });
    expect(cdp.attaching).toEqual([1, 1]);
  });
});
