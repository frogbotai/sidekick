import { race } from './abort';
import type { Sessions } from './sessions';
import type { Cdp, CdpEvent, Page, Tabs } from './types';

export const NETWORK_QUIET_MS = 500;

export const STALE_REQUEST_MS = 2_000;

export const NETWORK_CAP_MS = 5_000;

export const DOM_QUIET_MS = 100;

export const DOM_CAP_MS = 3_000;

const SWEEP_MS = 500;

const STREAMS = new Set(['WebSocket', 'EventSource']);

export interface SettleOptions {
  /** Waits for the page load before network quiet: the session attached after requests began. */
  load?: boolean;
}

/** Tracks requests from before `action` runs, then resolves `true` when the tab settled within the caps. */
export interface Settler {
  settle(
    tabId: number,
    signal: AbortSignal,
    action?: () => Promise<unknown>,
    options?: SettleOptions,
  ): Promise<boolean>;
}

function requestId(event: CdpEvent) {
  const id = event.params.requestId;

  return typeof id === 'string' ? id : undefined;
}

function finishes(event: CdpEvent) {
  if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
    return true;
  }

  if (event.method === 'Network.requestServedFromCache') return true;

  const response = event.params.response;

  if (event.method !== 'Network.responseReceived' || typeof response !== 'object' || !response) {
    return false;
  }

  return 'url' in response && typeof response.url === 'string' && response.url.startsWith('data:');
}

function track(cdp: Cdp, tabId: number) {
  const inflight = new Map<string, number>();
  let changed = () => {};

  const stop = cdp.onEvent((event) => {
    if (event.tabId !== tabId) return;

    const id = requestId(event);

    if (id === undefined) return;

    if (event.method === 'Network.requestWillBeSent') {
      const type = event.params.type;

      if (typeof type === 'string' && STREAMS.has(type)) return;

      inflight.set(id, Date.now());
      changed();
    } else if (finishes(event) && inflight.delete(id)) {
      changed();
    }
  });

  const quiet = () =>
    new Promise<boolean>((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (settled: boolean) => {
        clearTimeout(quietTimer);
        clearTimeout(cap);
        clearInterval(sweep);
        changed = () => {};

        resolve(settled);
      };

      const evaluate = () => {
        clearTimeout(quietTimer);
        quietTimer = undefined;

        if (inflight.size === 0) quietTimer = setTimeout(() => finish(true), NETWORK_QUIET_MS);
      };

      const sweep = setInterval(() => {
        const now = Date.now();
        const before = inflight.size;

        for (const [id, started] of inflight) {
          if (now - started > STALE_REQUEST_MS) inflight.delete(id);
        }

        if (inflight.size !== before) evaluate();
      }, SWEEP_MS);

      const cap = setTimeout(() => finish(false), NETWORK_CAP_MS);

      changed = evaluate;
      evaluate();
    });

  return { quiet, stop };
}

function capped(promise: Promise<boolean>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  return Promise.race([promise.catch(() => false), cap]).finally(() => clearTimeout(timer));
}

export function createSettler({
  cdp,
  page,
  tabs,
  sessions,
}: {
  cdp: Cdp;
  page: Page;
  tabs: Tabs;
  sessions: Sessions;
}): Settler {
  return {
    settle: async (tabId, signal, action, { load = false } = {}) => {
      const network = track(cdp, tabId);
      const waitForLoad = () => tabs.waitForLoad(tabId, NETWORK_CAP_MS).catch(() => false);

      try {
        await action?.();

        const loaded = !sessions.attached(tabId)
          ? waitForLoad()
          : load
            ? waitForLoad().then(async (done) => (await network.quiet()) && done)
            : network.quiet();

        const networkSettled = await race(loaded, signal);

        const dom = page.domQuiet(tabId, { quiet: DOM_QUIET_MS, cap: DOM_CAP_MS });
        const domSettled = await race(capped(dom, DOM_CAP_MS), signal);

        return networkSettled && domSettled;
      } finally {
        network.stop();
      }
    },
  };
}
