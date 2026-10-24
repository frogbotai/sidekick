import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeCdp, fakePage, fakeTabs, later, type Log } from './fakes';
import { START_TAB } from './harness';
import type { Sessions } from './sessions';
import { createSettler } from './settle';
import type { Page } from './types';

const signal = new AbortController().signal;

function sessions(attached: boolean): Sessions {
  return {
    start: later(() => undefined),
    ensure: later(() => undefined),
    send: later(() => ({})),
    attached: () => attached,
    onStripped: () => () => undefined,
    dispose: () => undefined,
  };
}

function setup({
  attached = true,
  page: overrides,
}: { attached?: boolean; page?: Partial<Page> } = {}) {
  const log: Log = [];
  const cdp = fakeCdp(log);
  const page = fakePage(log, overrides);
  const tabs = fakeTabs(log, [START_TAB]);
  const settler = createSettler({ cdp, page, tabs, sessions: sessions(attached) });

  const request = (requestId: string, type = 'XHR') =>
    cdp.emit({ tabId: 1, method: 'Network.requestWillBeSent', params: { requestId, type } });

  const finished = (requestId: string) =>
    cdp.emit({ tabId: 1, method: 'Network.loadingFinished', params: { requestId } });

  return { log, cdp, tabs, settler, request, finished };
}

function watch(promise: Promise<boolean>) {
  const state: { value?: boolean } = {};

  void promise.then((value) => (state.value = value));

  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settling (req. 18)', () => {
  it('waits for 500 ms of network quiet, then the DOM', async () => {
    const { settler, log } = setup();
    const state = watch(settler.settle(1, signal));

    await vi.advanceTimersByTimeAsync(499);

    expect(state.value).toBeUndefined();
    expect(log).not.toContain('page.domQuiet');

    await vi.advanceTimersByTimeAsync(1);

    expect(state.value).toBe(true);
    expect(log).toContain('page.domQuiet');
  });

  it('counts requests the action started, and restarts the quiet window when they finish', async () => {
    const { settler, request, finished } = setup();
    const state = watch(
      settler.settle(
        1,
        signal,
        later(() => request('r1')),
      ),
    );

    await vi.advanceTimersByTimeAsync(300);
    finished('r1');
    await vi.advanceTimersByTimeAsync(499);

    expect(state.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(state.value).toBe(true);
  });

  it('ignores WebSocket and EventSource requests', async () => {
    const { settler, request } = setup();
    const state = watch(
      settler.settle(
        1,
        signal,
        later(() => request('socket', 'WebSocket')),
      ),
    );

    await vi.advanceTimersByTimeAsync(500);

    expect(state.value).toBe(true);
  });

  it('sweeps a request older than 2 s, then settles', async () => {
    const { settler, request } = setup();
    const state = watch(
      settler.settle(
        1,
        signal,
        later(() => request('long-poll')),
      ),
    );

    await vi.advanceTimersByTimeAsync(2_499);

    expect(state.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1 + 500);

    expect(state.value).toBe(true);
  });

  it('gives settled: false at the 5 s network cap', async () => {
    const { settler, request } = setup();
    const state = watch(settler.settle(1, signal));
    let count = 0;

    const busy = setInterval(() => request(`r${count++}`), 400);

    await vi.advanceTimersByTimeAsync(4_999);

    expect(state.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    clearInterval(busy);

    expect(state.value).toBe(false);
  });

  it('gives settled: false at the 3 s DOM cap', async () => {
    const { settler } = setup({ page: { domQuiet: () => new Promise<boolean>(() => undefined) } });
    const state = watch(settler.settle(1, signal));

    await vi.advanceTimersByTimeAsync(500 + 2_999);

    expect(state.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(state.value).toBe(false);
  });

  it('waits for the tab to load when no session is attached', async () => {
    const { settler, log } = setup({ attached: false });

    await expect(settler.settle(1, signal)).resolves.toBe(true);
    expect(log).toEqual(['tabs.waitForLoad', 'page.domQuiet']);
  });

  it('with load, waits for the tab to load, then for network quiet, then the DOM', async () => {
    const { settler, log, request, finished } = setup();
    const state = watch(settler.settle(1, signal, undefined, { load: true }));

    request('chunk');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(log).toEqual(['tabs.waitForLoad']);
    expect(state.value).toBeUndefined();

    finished('chunk');
    await vi.advanceTimersByTimeAsync(500);

    expect(state.value).toBe(true);
    expect(log).toEqual(['tabs.waitForLoad', 'page.domQuiet']);
  });

  it('stops listening to CDP events when done', async () => {
    const { settler, cdp } = setup();
    const settled = settler.settle(1, signal);

    expect(cdp.listeners()).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    await settled;

    expect(cdp.listeners()).toBe(0);
  });
});

describe('settling after a navigation (331 req. 2)', () => {
  it('waits for the main frame to commit, then for quiet', async () => {
    const { settler, tabs, log } = setup();
    const state = watch(
      settler.settle(
        1,
        signal,
        later(() => undefined),
        { commit: true },
      ),
    );

    await vi.advanceTimersByTimeAsync(4_000);

    expect(state.value).toBeUndefined();
    expect(log).not.toContain('page.domQuiet');

    tabs.commit({ tabId: 2, url: 'https://other.test/' });
    await vi.advanceTimersByTimeAsync(500);

    expect(state.value).toBeUndefined();

    tabs.commit({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(499);

    expect(state.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(state.value).toBe(true);
  });

  it('ends the wait on a same-document commit too, so a # link doesn’t hang', async () => {
    const { settler, tabs } = setup();
    const settled = settler.settle(
      1,
      signal,
      later(() => tabs.commit({ tabId: 1, sameDocument: true })),
      { commit: true },
    );

    await vi.advanceTimersByTimeAsync(500);

    await expect(settled).resolves.toBe(true);
  });

  it('fails request_failed with Chrome’s text on a main-frame error, ignoring ERR_ABORTED', async () => {
    const { settler, tabs } = setup();
    const settled = settler.settle(
      1,
      signal,
      later(() => {
        tabs.failNavigation(1, 'net::ERR_ABORTED');
        tabs.failNavigation(1, 'net::ERR_NAME_NOT_RESOLVED');
      }),
      { commit: true },
    );

    await expect(settled).rejects.toMatchObject({
      code: 'request_failed',
      message: 'The page didn’t load: net::ERR_NAME_NOT_RESOLVED.',
    });
  });

  it('gives false at the 5 s cap without a commit, skipping the quiet wait', async () => {
    const { settler, tabs, log } = setup();
    const state = watch(
      settler.settle(
        1,
        signal,
        later(() => undefined),
        { commit: true },
      ),
    );

    await vi.advanceTimersByTimeAsync(4_999);

    expect(state.value).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(state.value).toBe(false);
    expect(log).not.toContain('page.domQuiet');

    tabs.commit({ tabId: 1 });
  });
});
