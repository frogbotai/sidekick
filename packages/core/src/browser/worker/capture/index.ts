import type { Sessions } from '../sessions';
import type { Cdp } from '../types';
import type { Taken } from './buffer';
import { captureConsole, type ConsoleEntry } from './console';
import { type NetworkEntry, redactKnown } from './entry';
import { captureNetwork } from './network';
import { SecretRedactor } from './redact';

/** How long a capture runs before it ends on its own, as browse does. */
export const CAPTURE_CAP_MS = 30 * 60_000;

/** Why a capture ended before `stop`. */
export type EndReason =
  'time_limit' | 'tab_closed' | 'devtools_opened' | 'canceled_by_user' | 'detached';

export type CaptureKind = 'network' | 'console';

interface Entries {
  network: NetworkEntry;
  console: ConsoleEntry;
}

/** What a read or stop returns: the entries since the last read, and the capture's state. */
export interface CaptureRead<T> extends Taken<T> {
  capturing: boolean;
  pending: number;
  ended?: EndReason;
}

export interface CaptureStart<T> {
  /** `false` when a capture of this kind was already running on the tab, which keeps running. */
  started: boolean;
  /** What a capture that ended on its own left unread, with why it ended. */
  previous?: CaptureRead<T>;
}

/** The running captures, per tab and kind. */
export interface Captures {
  start<K extends CaptureKind>(
    tabId: number,
    kind: K,
    options: { bodies?: boolean },
    signal: AbortSignal,
  ): Promise<CaptureStart<Entries[K]>>;
  /**
   * `undefined` when the tab has no capture of this kind to read. Entries `match` turns down stay
   * for a later read; an ended capture is forgotten once a read takes everything.
   */
  read<K extends CaptureKind>(
    tabId: number,
    kind: K,
    match?: (entry: Entries[K]) => boolean,
  ): CaptureRead<Entries[K]> | undefined;
  stop<K extends CaptureKind>(tabId: number, kind: K): Promise<CaptureRead<Entries[K]> | undefined>;
  dispose(): void;
}

interface Source<T> {
  take(match?: (entry: T) => boolean): Taken<T>;
  pending(): number;
  scrub(entry: T): T;
}

interface Running<T> extends Source<T> {
  stop(): Promise<void>;
  ended?: EndReason;
}

const DETACH_REASONS: Record<string, EndReason> = {
  target_closed: 'tab_closed',
  replaced_with_devtools: 'devtools_opened',
  canceled_by_user: 'canceled_by_user',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function createCaptures({ cdp, sessions }: { cdp: Cdp; sessions: Sessions }): Captures {
  const running: { [K in CaptureKind]: Map<number, Running<Entries[K]>> } = {
    network: new Map(),
    console: new Map(),
  };

  const redactors = new Map<number, SecretRedactor>();

  const redactorFor = (tabId: number) => {
    const found = redactors.get(tabId) ?? new SecretRedactor();

    redactors.set(tabId, found);

    return found;
  };

  const forget = (tabId: number, kind: CaptureKind) => {
    running[kind].delete(tabId);

    if (!running.network.has(tabId) && !running.console.has(tabId)) redactors.delete(tabId);
  };

  const mainFrame = async (tabId: number, signal: AbortSignal) => {
    const tree = record(await sessions.send(tabId, 'Page.getFrameTree', {}, signal));
    const id = record(record(tree.frameTree).frame).id;

    if (typeof id !== 'string') throw new Error('The tab has no main frame');

    return id;
  };

  const end = (tabId: number, reason: EndReason) => {
    for (const kind of ['network', 'console'] as const) {
      const capture = running[kind].get(tabId);

      if (!capture || capture.ended) continue;

      capture.ended = reason;
      void capture.stop();
    }
  };

  const hold = <T>(tabId: number, source: Source<T>, stop: () => Promise<void>) => {
    const release = sessions.hold(tabId);
    let stopping: Promise<void> | undefined;

    const capture: Running<T> = {
      take: (match) => source.take(match),
      pending: () => source.pending(),
      scrub: (entry) => source.scrub(entry),
      stop: () => {
        clearTimeout(timer);
        stopping ??= stop().finally(release);

        return stopping;
      },
    };

    const timer = setTimeout(() => {
      if (capture.ended) return;

      capture.ended = 'time_limit';
      void capture.stop();
    }, CAPTURE_CAP_MS);

    return capture;
  };

  const startNetwork = async (tabId: number, bodies: boolean, signal: AbortSignal) => {
    const frameId = await mainFrame(tabId, signal);
    const redactor = redactorFor(tabId);
    const capture = captureNetwork({ cdp, tabId, frameId, redactor, bodies });
    const source: Source<NetworkEntry> = {
      take: (match) => capture.take(match),
      pending: () => capture.pending(),
      scrub: (entry) => redactKnown(entry, redactor),
    };

    running.network.set(
      tabId,
      hold(tabId, source, () => Promise.resolve(capture.stop())),
    );
  };

  const disable = (tabId: number) =>
    Promise.all(
      ['Runtime.disable', 'Log.disable'].map((method) =>
        cdp.send(tabId, method, {}).catch(() => undefined),
      ),
    ).then(() => undefined);

  const startConsole = async (tabId: number, signal: AbortSignal) => {
    const frameId = await mainFrame(tabId, signal);
    const redactor = redactorFor(tabId);
    const capture = captureConsole({ cdp, tabId, frameId, redactor });
    const source: Source<ConsoleEntry> = {
      take: (match) => capture.take(match),
      pending: () => 0,
      scrub: (entry) => ({ ...entry, text: redactor.redactText(entry.text) }),
    };

    const entry = hold(tabId, source, () => {
      capture.stop();

      return disable(tabId);
    });

    running.console.set(tabId, entry);

    try {
      await sessions.send(tabId, 'Runtime.enable', {}, signal);
      await sessions.send(tabId, 'Log.enable', {}, signal);
    } catch (error) {
      await entry.stop();
      forget(tabId, 'console');

      throw error;
    }
  };

  const take = <K extends CaptureKind>(
    tabId: number,
    kind: K,
    match?: (entry: Entries[K]) => boolean,
  ) => {
    const capture = running[kind].get(tabId);

    if (!capture) return undefined;

    const { entries, dropped } = capture.take(match);

    return {
      capture,
      read: {
        entries: entries.map((item) => capture.scrub(item)),
        dropped,
        capturing: !capture.ended,
        pending: capture.pending(),
        ...(capture.ended ? { ended: capture.ended } : {}),
      },
    };
  };

  const unsubscribe = cdp.onDetach((tabId, reason) =>
    end(tabId, DETACH_REASONS[reason] ?? 'detached'),
  );

  return {
    start: async (tabId, kind, { bodies = false }, signal) => {
      const current = running[kind].get(tabId);

      if (current && !current.ended) return { started: false };

      const previous = current && take(tabId, kind)?.read;

      if (current) forget(tabId, kind);

      await sessions.ensure(tabId, signal);

      if (kind === 'network') await startNetwork(tabId, bodies, signal);
      else await startConsole(tabId, signal);

      return { started: true, ...(previous ? { previous } : {}) };
    },
    read: (tabId, kind, match) => {
      const taken = take(tabId, kind, match);

      if (taken?.capture.ended && !match) forget(tabId, kind);

      return taken?.read;
    },
    stop: async (tabId, kind) => {
      const capture = running[kind].get(tabId);

      if (!capture) return undefined;

      await capture.stop();

      const taken = take(tabId, kind);

      forget(tabId, kind);

      return taken && { ...taken.read, capturing: false };
    },
    dispose: () => {
      unsubscribe();

      for (const kind of ['network', 'console'] as const) {
        for (const capture of running[kind].values()) void capture.stop();

        running[kind].clear();
      }

      redactors.clear();
    },
  };
}
