import { ToolError } from '../../tool/tool';
import { race } from './abort';
import { dialogOpen, type Dialogs } from './dialogs';
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
  /**
   * Waits up to the network cap for the tab's main frame to commit first: settles `false` at once
   * without one, and fails `request_failed` on a main-frame error.
   */
  commit?: boolean;
  /** The action answers the dialog that is open, so it runs anyway. */
  answers?: boolean;
}

/**
 * Tracks requests from before `action` runs, then resolves `true` when the tab settled within the
 * caps. A dialog that opens on the tab ends it at once with `false`, and aborts the signal `action`
 * was given, so the action stops before its next step. A dialog already open fails `dialog_open`
 * without running `action`, unless the action answers it.
 */
export interface Settler {
  settle(
    tabId: number,
    signal: AbortSignal,
    action?: (signal: AbortSignal) => Promise<unknown>,
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

const ABORTED = 'net::ERR_ABORTED';

type Outcome = { committed: boolean } | { error: string };

function watchCommit(tabs: Tabs, tabId: number) {
  let done: (outcome: Outcome) => void = () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;

  const outcome = new Promise<Outcome>((resolve) => {
    done = resolve;
  });

  const stops = [
    tabs.onCommitted((commit) => {
      if (commit.tabId === tabId) done({ committed: true });
    }),
    tabs.onNavigationError((failure) => {
      if (failure.tabId === tabId && failure.error !== ABORTED) done({ error: failure.error });
    }),
  ];

  return {
    wait: () => {
      timer = setTimeout(() => done({ committed: false }), NETWORK_CAP_MS);

      return outcome;
    },
    stop: () => {
      clearTimeout(timer);

      for (const stop of stops) stop();
    },
  };
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
  dialogs,
}: {
  cdp: Cdp;
  page: Page;
  tabs: Tabs;
  sessions: Sessions;
  dialogs: Dialogs;
}): Settler {
  const settle = async (
    tabId: number,
    signal: AbortSignal,
    action: ((signal: AbortSignal) => Promise<unknown>) | undefined,
    { load = false, commit = false }: SettleOptions,
  ) => {
    const network = track(cdp, tabId);
    const committed = commit ? watchCommit(tabs, tabId) : undefined;
    const waitForLoad = () => tabs.waitForLoad(tabId, NETWORK_CAP_MS).catch(() => false);

    try {
      await action?.(signal);

      if (committed) {
        const outcome = await race(committed.wait(), signal);

        if ('error' in outcome) {
          throw new ToolError('request_failed', `The page didn’t load: ${outcome.error}.`);
        }

        if (!outcome.committed) return false;
      }

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
      committed?.stop();
    }
  };

  return {
    settle: async (tabId, signal, action, options = {}) => {
      const pending = dialogs.get(tabId);

      if (pending && !options.answers) throw dialogOpen(pending);

      const interrupt = new AbortController();
      const dialog = dialogs.opened(tabId);
      const body = settle(tabId, AbortSignal.any([signal, interrupt.signal]), action, options);

      try {
        return await Promise.race([body, dialog.promise.then(() => false)]);
      } finally {
        dialog.stop();
        interrupt.abort();
        body.catch(() => undefined);
      }
    },
  };
}
