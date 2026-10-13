import { vi } from 'vitest';

import { installFakeChrome } from '../../testing/fakeChrome';
import { fakeCdp, fakeContext, fakePage, fakeTabs, type Log } from './fakes';
import { createBrowserRuntime } from './runtime';
import type { Page, TabInfo } from './types';

export const START_TAB: TabInfo = {
  id: 1,
  windowId: 1,
  groupId: -1,
  url: 'https://example.com/',
  title: 'Example',
  active: true,
};

export const OUTSIDE_TAB: TabInfo = {
  id: 2,
  windowId: 1,
  groupId: -1,
  url: 'https://other.test/',
  title: 'Other',
  active: false,
};

export async function setupBrowser({
  mac = false,
  page: overrides,
}: { mac?: boolean; page?: Partial<Page> } = {}) {
  const storage = installFakeChrome();
  const log: Log = [];
  const cdp = fakeCdp(log);
  const page = fakePage(log, overrides);
  const tabs = fakeTabs(log, [START_TAB, OUTSIDE_TAB]);
  const runtime = createBrowserRuntime({ cdp, page, tabs, mac });
  const run = await runtime.env.runs.start({ tabId: START_TAB.id, label: 'Task' });
  const ctx = fakeContext(log, run.id);

  const tool = (id: string) => {
    const found = runtime.tools.find((entry) => entry.id === id);

    if (!found) throw new Error(`No tool ${id}`);

    return found;
  };

  log.length = 0;

  return { storage, log, cdp, page, tabs, runtime, run, ctx, tool };
}

/** Advances fake time until `promise` settles, so settling timers don't stall a test. */
export async function drain<T>(promise: Promise<T>, step = 100, limit = 200): Promise<T> {
  let done = false;

  promise.then(
    () => (done = true),
    () => (done = true),
  );

  for (let count = 0; count < limit && !done; count++) await vi.advanceTimersByTimeAsync(step);

  return promise;
}

export async function failure(promise: Promise<unknown>) {
  return drain(promise).then(
    () => undefined,
    (error: unknown) => error,
  );
}

export function sentMethods(sent: { method: string }[]) {
  return sent.map(({ method }) => method);
}
