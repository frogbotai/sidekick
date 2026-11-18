import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeChrome } from '../../testing/fakeChrome';
import { fakeCdp, fakePage, fakeTabs, later, type Log } from './fakes';
import { OUTSIDE_TAB, START_TAB } from './harness';
import { createBrowserRuntime } from './runtime';
import { createBrowserWorker } from './serve';

function setup() {
  installFakeChrome();

  const log: Log = [];
  const shown: { tabId: number; visible?: boolean }[] = [];

  const page = fakePage(log, {
    iframes: later(() => [{ frameId: 0, sources: ['chrome-extension://abcdef/inject.html'] }]),
    strip: later(() => ['chrome-extension://abcdef/inject.html']),
    indicator: later((tabId: number, state: { visible?: boolean }) => {
      shown.push({ tabId, visible: state.visible });
    }),
  });

  const tabs = fakeTabs(log, [START_TAB, OUTSIDE_TAB]);
  const cdp = fakeCdp(log);
  const runtime = createBrowserRuntime({ cdp, page, tabs, mac: false });
  const worker = createBrowserWorker(runtime);
  const emitted: { type: string; data: unknown }[] = [];

  worker.connect({ emit: (type, data) => void emitted.push({ type, data }) });

  return { runtime, worker, cdp, tabs, shown, emitted };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the browser worker', () => {
  it('starts a run in a new group and shows the indicator there', async () => {
    const { worker, tabs, shown } = setup();
    const { groupId } = await worker.handlers['run.start']({ tabId: 1, label: 'Task' });

    await vi.runAllTimersAsync();

    expect(tabs.tabs.get(1)?.groupId).toBe(groupId);
    expect(shown).toEqual([{ tabId: 1, visible: true }]);
  });

  it('shows it in a tab opened from the group, and hides it in both when the run stops', async () => {
    const { worker, tabs, shown, emitted } = setup();
    const { runId } = await worker.handlers['run.start']({ tabId: 1, label: 'Task' });

    tabs.createTab({ id: 9, sourceTabId: 1 });
    await vi.runAllTimersAsync();
    await worker.handlers['run.stop']({ runId });
    await vi.runAllTimersAsync();

    expect(shown).toEqual([
      { tabId: 1, visible: true },
      { tabId: 9, visible: true },
      { tabId: 1, visible: false },
      { tabId: 9, visible: false },
    ]);

    expect(emitted).toEqual([{ type: 'run.stopped', data: { runId, reason: 'user' } }]);
  });

  it('tells a content script its frame id, from Chrome’s sender, and the worker’s key', async () => {
    const { worker } = setup();

    expect(await worker.content({ tabId: 1, frameId: 7 })['frame.identify']({})).toEqual({
      frameId: 7,
      key: 'worker-key',
    });
  });

  it('tells a content script whether its own tab is in a run', async () => {
    const { worker } = setup();

    await worker.handlers['run.start']({ tabId: 1, label: 'Task' });

    expect(await worker.content({ tabId: 1, frameId: 0 })['indicator.state']({})).toEqual({
      visible: true,
    });

    expect(await worker.content({ tabId: 2, frameId: 0 })['indicator.state']({})).toEqual({
      visible: false,
    });
  });

  it('stops the run its tab is in when the indicator’s Stop is clicked', async () => {
    const { worker, runtime, emitted } = setup();
    const { runId } = await worker.handlers['run.start']({ tabId: 1, label: 'Task' });

    await worker.content({ tabId: 2, frameId: 0 })['indicator.stop']({});

    expect(runtime.env.runs.get(runId)).toBeDefined();

    await worker.content({ tabId: 1, frameId: 0 })['indicator.stop']({});

    expect(runtime.env.runs.get(runId)).toBeUndefined();
    expect(emitted).toEqual([{ type: 'run.stopped', data: { runId, reason: 'user' } }]);
  });

  it('tells the panel when it stripped another extension’s frame', async () => {
    const { runtime, cdp, emitted } = setup();

    cdp.attachErrors.push(
      new Error('Cannot access a chrome-extension:// URL of different extension'),
    );

    await Promise.all([runtime.env.sessions.ensure(1), vi.runAllTimersAsync()]);

    expect(emitted).toEqual([
      { type: 'page.stripped', data: { tabId: 1, removed: ['chrome-extension://abcdef'] } },
    ]);
  });

  it('keeps one run per chat, hides its indicator between messages, and ends it on close', async () => {
    const { worker, runtime, shown, emitted } = setup();
    const first = await worker.sessionRun({ sessionID: 's1', windowId: 1 });
    const again = await worker.sessionRun({ sessionID: 's1', windowId: 1 });
    const state = () => worker.content({ tabId: 1, frameId: 0 })['indicator.state']({});

    expect(again).toEqual(first);
    expect(runtime.env.runs.get(first.id)).toMatchObject({ sessionID: 's1', label: 'Sidekick' });

    await worker.handlers['run.end']({ sessionID: 's1', close: false });
    await vi.runAllTimersAsync();

    expect(await state()).toEqual({ visible: false });

    await worker.sessionRun({ sessionID: 's1', windowId: 1 });
    await vi.runAllTimersAsync();

    expect(await state()).toEqual({ visible: true });

    expect(shown).toEqual([
      { tabId: 1, visible: true },
      { tabId: 1, visible: false },
      { tabId: 1, visible: true },
    ]);

    await worker.handlers['run.end']({ sessionID: 's1', close: true });

    expect(runtime.env.runs.get(first.id)).toBeUndefined();

    expect(emitted).toEqual([
      { type: 'run.stopped', data: { runId: first.id, reason: 'user', sessionID: 's1' } },
    ]);

    const next = await worker.sessionRun({ sessionID: 's1', windowId: 1 });

    expect(next.id).not.toBe(first.id);
  });

  it('refuses a chat’s first browser call without a window', async () => {
    const { worker } = setup();

    await expect(worker.sessionRun({ sessionID: 's1' })).rejects.toMatchObject({
      code: 'invalid_target',
    });
  });
});

describe('handing the tab back (sidekick-17 req. 24)', () => {
  it('clears the run’s emulation on run.end but keeps the run', async () => {
    const { runtime, worker, cdp } = setup();
    const { id } = await worker.sessionRun({ sessionID: 'ses-1', windowId: 1 });

    await vi.advanceTimersByTimeAsync(100);

    const set = runtime.env.emulation.set({
      tabId: 1,
      runId: id,
      overrides: { color_scheme: 'dark' },
    });

    await vi.advanceTimersByTimeAsync(100);
    await set;
    cdp.sent.length = 0;

    await worker.handlers['run.end']({ sessionID: 'ses-1', close: false });
    await vi.advanceTimersByTimeAsync(100);

    expect(cdp.sent.map(({ method }) => method)).toContain('Emulation.clearGeolocationOverride');
    expect(runtime.env.emulation.active(1)).toEqual({});
    expect(runtime.env.runs.get(id)).toBeDefined();
  });

  it('leaves nothing on the tab when run.end lands while an emulate call is attaching (PR #48 review finding 3)', async () => {
    const { runtime, worker, cdp } = setup();
    const { id } = await worker.sessionRun({ sessionID: 'ses-1', windowId: 1 });
    const { emulation } = runtime.env;

    await vi.advanceTimersByTimeAsync(100);

    let attached = () => {};

    cdp.attach = (tabId: number) =>
      new Promise<void>((resolve) => {
        attached = () => {
          cdp.attaching.push(tabId);
          cdp.sessions.add(tabId);
          resolve();
        };
      });

    const set = emulation.set({ tabId: 1, runId: id, overrides: { color_scheme: 'dark' } });

    await vi.advanceTimersByTimeAsync(50);
    await worker.handlers['run.end']({ sessionID: 'ses-1', close: false });
    attached();
    await vi.advanceTimersByTimeAsync(100);

    await expect(set).rejects.toMatchObject({ code: 'stopped' });
    expect(emulation.active(1)).toEqual({});

    await vi.advanceTimersByTimeAsync(20_100);

    expect(cdp.detached).toEqual([1]);
  });
});
