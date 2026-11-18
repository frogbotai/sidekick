import { ToolError } from '../../tool/tool';
import { messageOf, race } from './abort';
import { isExtensionFrameError, otherExtension, stripAndRetry } from './strip';
import type { Cdp, Page, Tabs } from './types';

export const IDLE_DETACH_MS = 20_000;

export const ATTACH_TIMEOUT_MS = 5_000;

export const COMMAND_TIMEOUT_MS = 10_000;

const NEVER = new AbortController().signal;

export interface Stripped {
  tabId: number;
  removed: string[];
}

export interface Sessions {
  start(): Promise<void>;
  ensure(tabId: number, signal?: AbortSignal): Promise<void>;
  send(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    options?: SendOptions,
  ): Promise<unknown>;
  attached(tabId: number): boolean;
  /** Keeps the tab's session from the idle detach while `on`, so state like emulation stays put. */
  hold(tabId: number, on: boolean): void;
  /** Runs after each attach, before its first command; the attach waits for it. */
  onAttached(listener: (tabId: number) => Promise<void>): () => void;
  onStripped(listener: (event: Stripped) => void): () => void;
  dispose(): void;
}

/** `timeout`: how long Chrome may take to answer. `once`: never re-send after a lost session, for commands that must not run twice. */
export interface SendOptions {
  timeout?: number;
  once?: boolean;
}

export interface SessionsOptions {
  cdp: Cdp;
  tabs: Tabs;
  page: Page;
  idleMs?: number;
}

function blocked(reason: 'policy' | 'devtools_open' | 'restricted_url', message: string) {
  return new ToolError('attach_blocked', message, { reason });
}

function attachError(error: unknown): unknown {
  const message = messageOf(error);

  if (isExtensionFrameError(error)) return otherExtension();

  if (/restricted by policy/i.test(message)) {
    return blocked(
      'policy',
      'Browser policy blocks trusted input on this site. Reading still works.',
    );
  }

  if (/another debugger is already attached/i.test(message)) {
    return blocked(
      'devtools_open',
      'Another debugger holds this tab. Ask the user to close DevTools or the other tool, then retry.',
    );
  }

  if (/cannot (access|attach to)|chrome:\/\//i.test(message)) {
    return blocked(
      'restricted_url',
      'Chrome doesn’t allow input on this page. Navigate to a website first.',
    );
  }

  return error;
}

function lostSession(error: unknown) {
  const message = messageOf(error).toLowerCase();

  return (
    message.includes('debugger is not attached') ||
    message.includes('detached while handling command')
  );
}

export function createSessions({
  cdp,
  tabs,
  page,
  idleMs = IDLE_DETACH_MS,
}: SessionsOptions): Sessions {
  const sessions = new Map<
    number,
    { ready: Promise<void>; busy: number; timer?: ReturnType<typeof setTimeout> }
  >();

  const strippedListeners = new Set<(event: Stripped) => void>();
  const attachedListeners = new Set<(tabId: number) => Promise<void>>();
  const held = new Set<number>();

  const drop = (tabId: number) => {
    clearTimeout(sessions.get(tabId)?.timer);
    sessions.delete(tabId);
  };

  const touch = (tabId: number) => {
    const session = sessions.get(tabId);

    if (!session) return;

    clearTimeout(session.timer);

    session.timer = setTimeout(() => {
      if (session.busy > 0 || held.has(tabId)) {
        touch(tabId);

        return;
      }

      drop(tabId);
      void cdp.detach(tabId).catch(() => undefined);
    }, idleMs);
  };

  const rawAttach = async (tabId: number) => {
    const timeout = { ms: ATTACH_TIMEOUT_MS, what: 'Attaching the debugger' };

    try {
      await race(cdp.attach(tabId), NEVER, timeout);
    } catch (error) {
      if (error instanceof ToolError && error.code === 'timeout') {
        throw blocked(
          'devtools_open',
          'The debugger didn’t attach. DevTools may be open on this tab; ask the user to close it.',
        );
      }

      throw error;
    }
  };

  const attach = async (tabId: number) => {
    try {
      await rawAttach(tabId);
    } catch (error) {
      if (!isExtensionFrameError(error)) throw attachError(error);

      await stripAndRetry(tabId, {
        tabs,
        page,
        attach: () => rawAttach(tabId),
        onStripped: (event) => {
          for (const listener of [...strippedListeners]) listener(event);
        },
      });
    }

    await race(cdp.send(tabId, 'Network.enable', {}), NEVER, {
      ms: COMMAND_TIMEOUT_MS,
      what: 'Network.enable',
    });

    await Promise.all(
      [...attachedListeners].map((listener) =>
        race(listener(tabId), NEVER, { ms: COMMAND_TIMEOUT_MS, what: 'Restoring the tab' }).catch(
          () => undefined,
        ),
      ),
    );
  };

  const ensure = async (tabId: number, signal = NEVER) => {
    let session = sessions.get(tabId);

    if (!session) {
      const ready = attach(tabId);

      session = { ready, busy: 0 };
      sessions.set(tabId, session);

      ready.catch(() => {
        if (sessions.get(tabId)?.ready === ready) drop(tabId);
      });
    }

    await race(session.ready, signal);
    touch(tabId);
  };

  const sendOnce = async (
    tabId: number,
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    ms: number,
  ) => {
    const session = sessions.get(tabId);

    if (session) session.busy++;

    try {
      return await race(cdp.send(tabId, method, params), signal, { ms, what: method });
    } finally {
      if (session) session.busy--;
    }
  };

  const unsubscribe = cdp.onDetach((tabId) => drop(tabId));

  return {
    start: async () => {
      const leftover = await cdp.attachedTabs().catch(() => []);

      await Promise.all(leftover.map((tabId) => cdp.detach(tabId).catch(() => undefined)));
    },
    ensure,
    send: async (tabId, method, params, signal = NEVER, options = {}) => {
      const { timeout = COMMAND_TIMEOUT_MS, once = false } = options;

      await ensure(tabId, signal);

      try {
        const result = await sendOnce(tabId, method, params, signal, timeout);

        touch(tabId);

        return result;
      } catch (error) {
        const reattach =
          lostSession(error) || (isExtensionFrameError(error) && !sessions.has(tabId));

        if (!reattach || once) throw error;

        drop(tabId);
        await ensure(tabId, signal);

        return sendOnce(tabId, method, params, signal, timeout);
      }
    },
    attached: (tabId) => sessions.has(tabId),
    hold: (tabId, on) => {
      if (on) held.add(tabId);
      else held.delete(tabId);
    },
    onAttached: (listener) => {
      attachedListeners.add(listener);

      return () => void attachedListeners.delete(listener);
    },
    onStripped: (listener) => {
      strippedListeners.add(listener);

      return () => void strippedListeners.delete(listener);
    },
    dispose: () => {
      unsubscribe();

      for (const tabId of [...sessions.keys()]) drop(tabId);
    },
  };
}
