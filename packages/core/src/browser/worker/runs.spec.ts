import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function codeOf(error: unknown) {
  return error instanceof ToolError ? error.code : error;
}

describe('runs and tab groups (req. 20, 22)', () => {
  it('groups the start tab under the run’s label', async () => {
    const { run, tabs } = await setupBrowser();

    expect(tabs.tabs.get(1)?.groupId).toBe(run.groupId);
    expect(run).toMatchObject({ label: 'Task', windowId: 1 });
  });

  it('adds tabs opened by group tabs, and leaves others alone', async () => {
    const { run, tabs } = await setupBrowser();

    tabs.createTab({ id: 7, sourceTabId: 1, url: 'https://example.com/popup' });
    tabs.createTab({ id: 8, sourceTabId: 2, url: 'https://other.test/popup' });
    tabs.createTab({ id: 9, url: 'chrome://newtab/' });
    await vi.advanceTimersByTimeAsync(0);

    expect(tabs.tabs.get(7)?.groupId).toBe(run.groupId);
    expect(tabs.tabs.get(8)?.groupId).toBe(-1);
    expect(tabs.tabs.get(9)?.groupId).toBe(-1);
  });

  it('opens tabs_open tabs in the group, in the background by default', async () => {
    const { tool, ctx, tabs, run } = await setupBrowser();

    const { output } = await drain(tool('tabs_open').execute({ url: 'localhost:5173/a' }, ctx));

    expect(output).toEqual({ tab_id: 1000, url: 'http://localhost:5173/a', settled: true });
    expect(tabs.tabs.get(1000)).toMatchObject({ groupId: run.groupId, active: false });

    const { output: listed } = await drain(tool('tabs_list').execute({}, ctx));

    expect(listed).toEqual({
      tabs: [
        { tab_id: 1, url: 'https://example.com/', title: 'Example', active: true },
        { tab_id: 1000, url: 'http://localhost:5173/a', title: '', active: false },
      ],
    });
  });

  it('refuses a tab dragged out of the group with not_in_group', async () => {
    const { tool, ctx, tabs } = await setupBrowser();
    const tab = tabs.tabs.get(1);

    if (tab) tab.groupId = -1;

    expect(codeOf(await failure(tool('snapshot').execute({ tab_id: 1 }, ctx)))).toBe(
      'not_in_group',
    );
  });

  it('ends the run when its group is closed', async () => {
    const { tool, ctx, tabs, run, runtime } = await setupBrowser();
    const stopped: unknown[] = [];

    runtime.env.runs.onStopped((event) => stopped.push(event));
    tabs.removeGroup(run.groupId);

    expect(stopped).toEqual([{ runId: run.id, reason: 'group_closed' }]);
    expect(runtime.env.runs.get(run.id)).toBeUndefined();
    expect(codeOf(await failure(tool('tabs_list').execute({}, ctx)))).toBe('stopped');
  });

  it('gives stopped when the run is stopped mid-action', async () => {
    const { tool, ctx, run, runtime, cdp } = await setupBrowser();
    const click = tool('click')
      .execute({ tab_id: 1, ref: 'f0e1' }, ctx)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    runtime.env.runs.stop(run.id);

    expect(codeOf(await click)).toBe('stopped');
    expect(cdp.sent.filter(({ method }) => method === 'Input.dispatchMouseEvent')).toHaveLength(3);
  });

  it('gives stopped when the call is aborted, before any input', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        scrollTo: later(() => {
          ctx.controller.abort();

          return {
            point: { x: 1, y: 1 },
            rect: { x: 0, y: 0, width: 1, height: 1 },
            in_view: true,
          };
        }),
      },
    });

    expect(codeOf(await failure(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx)))).toBe(
      'stopped',
    );

    expect(cdp.sent.filter(({ method }) => method.startsWith('Input.'))).toEqual([]);
  });
});

describe('screenshots (req. 19) and their coordinates (271 D3)', () => {
  it('captures the viewport through CDP at the asked scale', async () => {
    const { tool, ctx, cdp, log } = await setupBrowser();

    const result = await drain(tool('screenshot').execute({ tab_id: 1, scale: 0.5 }, ctx));
    const capture = cdp.sent.find(({ method }) => method === 'Page.captureScreenshot');

    expect(capture?.params.clip).toEqual({ x: 0, y: 500, width: 800, height: 600, scale: 0.5 });
    expect(result.output).toEqual({ url: 'https://example.com/', width: 400, height: 300 });

    expect(result.content?.[1]).toEqual({
      type: 'file',
      uri: 'data:image/jpeg;base64,SU1H',
      mime: 'image/jpeg',
      name: 'screenshot',
    });

    const shot = log.indexOf('cdp.Page.captureScreenshot');

    expect([log[shot - 1], log[shot + 1]]).toEqual(['page.indicator', 'page.indicator']);
    expect(log).not.toContain('cdp.Emulation.setFocusEmulationEnabled');
  });

  it('maps screenshot pixels back to viewport pixels for click', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('screenshot').execute({ tab_id: 1, scale: 0.5 }, ctx));
    await drain(tool('click').execute({ tab_id: 1, x: 100, y: 50 }, ctx));

    expect(cdp.sent.find(({ params }) => params.type === 'mousePressed')?.params).toMatchObject({
      x: 200,
      y: 100,
    });
  });

  it('offsets by the element for a ref screenshot', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('screenshot').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(cdp.sent.find(({ method }) => method === 'Page.captureScreenshot')?.params.clip).toEqual(
      {
        x: 50,
        y: 650,
        width: 100,
        height: 100,
        scale: 1,
      },
    );

    await drain(tool('hover').execute({ tab_id: 1, x: 10, y: 10 }, ctx));

    expect(cdp.sent.at(-1)?.params).toMatchObject({ type: 'mouseMoved', x: 60, y: 160 });
  });

  it('treats x and y as viewport pixels before any screenshot', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('click').execute({ tab_id: 1, x: 30, y: 40 }, ctx));

    expect(cdp.sent.find(({ params }) => params.type === 'mousePressed')?.params).toMatchObject({
      x: 30,
      y: 40,
    });
  });

  it('turns on focus emulation for a background tab', async () => {
    const { tool, ctx, cdp, tabs } = await setupBrowser();
    const tab = tabs.tabs.get(1);

    if (tab) tab.active = false;

    await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    expect(cdp.sent.map(({ method }) => method).slice(-2)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Page.captureScreenshot',
    ]);
  });

  it('uses captureVisibleTab when attach is blocked on the active tab', async () => {
    const { tool, ctx, cdp, runtime } = await setupBrowser();

    cdp.attachErrors.push(new Error('Host access is restricted by policy.'));

    const result = await drain(tool('screenshot').execute({ tab_id: 1 }, ctx));

    expect(result.output).toEqual({ url: 'https://example.com/', width: 1600, height: 1200 });

    expect(runtime.env.screens.get(1)).toEqual({
      offset: { x: 0, y: 0 },
      scale: { x: 0.5, y: 0.5 },
    });
  });

  it('refuses a ref without a ref or coordinates', async () => {
    const { tool, ctx } = await setupBrowser();

    expect(codeOf(await failure(tool('click').execute({ tab_id: 1, x: 5 }, ctx)))).toBe(
      'invalid_target',
    );
  });
});

describe('navigate back and forward', () => {
  it('goes to the next history entry over CDP, which skips nothing', async () => {
    const { tool, ctx, cdp, log } = await setupBrowser();

    cdp.replies.set('Page.getNavigationHistory', () => ({
      currentIndex: 1,
      entries: [{ id: 10 }, { id: 11 }, { id: 12 }],
    }));

    await drain(tool('navigate').execute({ tab_id: 1, go: 'back' }, ctx));
    await drain(tool('navigate').execute({ tab_id: 1, go: 'forward' }, ctx));

    expect(
      cdp.sent
        .filter(({ method }) => method === 'Page.navigateToHistoryEntry')
        .map((sent) => sent.params),
    ).toEqual([{ entryId: 10 }, { entryId: 12 }]);

    expect(log).not.toContain('tabs.history');
  });

  it('gives invalid_target at either end of the history', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Page.getNavigationHistory', () => ({
      currentIndex: 0,
      entries: [{ id: 10 }],
    }));

    for (const go of ['back', 'forward'] as const) {
      const error = await failure(tool('navigate').execute({ tab_id: 1, go }, ctx));

      expect(codeOf(error)).toBe('invalid_target');
    }

    expect(cdp.sent.map(({ method }) => method)).not.toContain('Page.navigateToHistoryEntry');
  });

  it('falls back to chrome.tabs when attach is blocked, mapping Chrome’s no-entry error', async () => {
    const { tool, ctx, cdp, tabs, log } = await setupBrowser();

    for (let attempt = 0; attempt < 10; attempt++) {
      cdp.attachErrors.push(
        new Error('Cannot access a chrome-extension:// URL of different extension'),
      );
    }

    tabs.history = later(() => {
      throw new Error('Cannot find a next page in history.');
    });

    const error = await failure(tool('navigate').execute({ tab_id: 1, go: 'back' }, ctx));

    expect(error).toMatchObject({
      code: 'invalid_target',
      message: 'This tab has no previous page in its history.',
    });

    expect(log).not.toContain('cdp.Page.getNavigationHistory');
  });
});
