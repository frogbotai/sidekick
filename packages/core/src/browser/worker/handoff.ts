import { ToolError } from '../../tool/tool';
import { race } from './abort';
import type { HandoffCard, Page, Tabs } from './types';

/** How long a handoff waits by default, and at most (sidekick-13 D2). */
export const HANDOFF_TIMEOUT = 600_000;

export const HANDOFF_BADGE = 'WAIT';

/** How often a waiting handoff shows its card again, in case the page removed it or reloaded. */
export const HANDOFF_HEARTBEAT = 5_000;

/** How a handoff ended: Continue, its deadline, or the run or tab going away. */
export type HandoffEnd =
  | { status: 'resolved' }
  | { status: 'timeout' }
  | { status: 'cancelled'; reason: 'stopped' | 'tab_closed' };

/** A waiting handoff, as the panel and the page's card show it. */
export interface HandoffAsk extends HandoffCard {
  tabId: number;
  /** The chat whose run asked; unset for an MCP client. */
  sessionID?: string;
}

export interface HandoffWait {
  tabId: number;
  message: string;
  timeout: number;
  signal: AbortSignal;
  sessionID?: string;
}

/** The handoffs waiting on the person, at most one per tab (sidekick-13 req. 3, 7, 9, 12). */
export interface Handoffs {
  /** Shows the card and the badge, and settles when the handoff ends; never rejects. */
  wait(input: HandoffWait): Promise<HandoffEnd>;
  /** Resolves handoff `id`, when it is still waiting and, given `tabId`, on that tab. */
  resolve(id: string, tabId?: number): boolean;
  /** The handoff waiting on a tab, for a new document's card. */
  pending(tabId: number): HandoffAsk | undefined;
  /** Settles once no handoff waits on the tab; rejects `stopped` when `signal` aborts first. */
  idle(tabId: number, signal: AbortSignal): Promise<void>;
  /** Aborts with `handed_off` when a handoff starts on the tab, so calls already running there end (req. 6). */
  guard(tabId: number): AbortSignal;
  list(sessionID?: string): HandoffAsk[];
  onAsked(listener: (ask: HandoffAsk) => void): () => void;
  onEnded(listener: (event: { id: string; sessionID?: string }) => void): () => void;
  dispose(): void;
}

interface Waiting {
  ask: HandoffAsk;
  end: (result: HandoffEnd) => void;
}

function listeners<A>() {
  const set = new Set<(event: A) => void>();

  return {
    add: (listener: (event: A) => void) => {
      set.add(listener);

      return () => void set.delete(listener);
    },
    emit: (event: A) => {
      for (const listener of [...set]) listener(event);
    },
  };
}

/**
 * After browse's handoff registry: a second handoff on a tab ends the first as `timeout`, and
 * every end removes the card and clears the badge. Chrome drops a tab's badge text when it
 * navigates, so each commit on a waiting tab sets it again. A page the card can't reach, like a
 * PDF, an error page or a crashed tab, keeps the handoff waiting: the panel's Continue still
 * ends it, and Chrome tells an extension nothing about a crash without the debugger.
 */
export function createHandoffs({ tabs, page }: { tabs: Tabs; page: Page }): Handoffs {
  const waiting = new Map<number, Waiting>();
  const guards = new Map<number, AbortController>();
  const asked = listeners<HandoffAsk>();
  const ended = listeners<{ id: string; sessionID?: string }>();

  const badge = (tabId: number, text: string) =>
    void tabs.badge(tabId, text).catch(() => undefined);

  const card = (tabId: number, shown: HandoffCard | null) =>
    void page.handoff(tabId, shown).catch(() => undefined);

  const unsubscribers = [
    tabs.onRemoved((tabId) => {
      guards.delete(tabId);
      waiting.get(tabId)?.end({ status: 'cancelled', reason: 'tab_closed' });
    }),
    tabs.onCommitted(({ tabId }) => {
      if (waiting.has(tabId)) badge(tabId, HANDOFF_BADGE);
    }),
  ];

  const interrupt = (tabId: number) => {
    guards
      .get(tabId)
      ?.abort(
        new ToolError(
          'handed_off',
          `The user took over tab ${tabId} for a handoff while this call ran. Take a new snapshot once the handoff ends.`,
        ),
      );

    guards.delete(tabId);
  };

  const wait = ({ tabId, message, timeout, signal, sessionID }: HandoffWait) =>
    new Promise<HandoffEnd>((settle) => {
      waiting.get(tabId)?.end({ status: 'timeout' });

      if (signal.aborted) {
        settle({ status: 'cancelled', reason: 'stopped' });

        return;
      }

      const ask: HandoffAsk = {
        id: crypto.randomUUID(),
        message,
        tabId,
        ...(sessionID ? { sessionID } : {}),
      };

      const onAbort = () => entry.end({ status: 'cancelled', reason: 'stopped' });
      const timer = setTimeout(() => entry.end({ status: 'timeout' }), timeout);

      const heartbeat = setInterval(() => card(tabId, { id: ask.id, message }), HANDOFF_HEARTBEAT);

      const entry: Waiting = {
        ask,
        end: (result) => {
          if (waiting.get(tabId) !== entry) return;

          waiting.delete(tabId);
          clearTimeout(timer);
          clearInterval(heartbeat);
          signal.removeEventListener('abort', onAbort);
          card(tabId, null);
          badge(tabId, '');
          ended.emit({ id: ask.id, ...(sessionID ? { sessionID } : {}) });
          settle(result);
        },
      };

      waiting.set(tabId, entry);
      interrupt(tabId);
      signal.addEventListener('abort', onAbort, { once: true });
      card(tabId, { id: ask.id, message });
      badge(tabId, HANDOFF_BADGE);
      asked.emit(ask);
    });

  return {
    wait,
    resolve: (id, tabId) => {
      const entry = [...waiting.values()].find(({ ask }) => ask.id === id);

      if (!entry || (tabId !== undefined && entry.ask.tabId !== tabId)) return false;

      entry.end({ status: 'resolved' });

      return true;
    },
    pending: (tabId) => waiting.get(tabId)?.ask,
    idle: (tabId, signal) =>
      race(
        new Promise<void>((done) => {
          if (!waiting.has(tabId)) {
            done();

            return;
          }

          const stop = ended.add(() => {
            if (waiting.has(tabId)) return;

            stop();
            done();
          });
        }),
        signal,
      ),
    guard: (tabId) => {
      let guard = guards.get(tabId);

      if (!guard) {
        guard = new AbortController();
        guards.set(tabId, guard);
      }

      return guard.signal;
    },
    list: (sessionID) =>
      [...waiting.values()]
        .map(({ ask }) => ask)
        .filter((ask) => sessionID === undefined || ask.sessionID === sessionID),
    onAsked: asked.add,
    onEnded: ended.add,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
