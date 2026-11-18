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
  /** Older entries `fit` left out, kept for the next read. */
  left: number;
  ended?: EndReason;
}

/**
 * How a read picks its entries. `match` turns entries down for a later read; `fit` says how many of
 * the newest ones the reply has room for, and the older rest stay for the next read.
 */
export interface ReadOptions<T> {
  match?: (entry: T) => boolean;
  fit?: (entries: T[]) => number;
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
    options: { bodies?: boolean; owner: string; fit?: (entries: Entries[K][]) => number },
    signal: AbortSignal,
  ): Promise<CaptureStart<Entries[K]>>;
  /**
   * `undefined` when the tab has no capture of this kind to read. A capture that has ended or been
   * stopped is forgotten once a read takes everything.
   */
  read<K extends CaptureKind>(
    tabId: number,
    kind: K,
    options?: ReadOptions<Entries[K]>,
  ): CaptureRead<Entries[K]> | undefined;
  stop<K extends CaptureKind>(
    tabId: number,
    kind: K,
    options?: ReadOptions<Entries[K]>,
  ): Promise<CaptureRead<Entries[K]> | undefined>;
  /** The run that started the tab's capture of this kind, so a closed tab's capture can still be read. */
  owner(tabId: number, kind: CaptureKind): string | undefined;
  dispose(): void;
}

interface Source<T> {
  take(match?: (entry: T) => boolean): Taken<T>;
  restore(entries: T[]): void;
  size(): number;
  pending(): number;
  scrub(entry: T): T;
}

interface Running<T> extends Source<T> {
  owner: string;
  stop(): Promise<void>;
  ended?: EndReason;
  stopped?: boolean;
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

  const hold = <T>(tabId: number, owner: string, source: Source<T>, stop: () => Promise<void>) => {
    const release = sessions.hold(tabId);
    let stopping: Promise<void> | undefined;

    const capture: Running<T> = {
      ...source,
      owner,
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

  const startNetwork = async (
    tabId: number,
    owner: string,
    bodies: boolean,
    signal: AbortSignal,
  ) => {
    const frameId = await mainFrame(tabId, signal);
    const redactor = redactorFor(tabId);
    const capture = captureNetwork({ cdp, tabId, frameId, redactor, bodies });
    const source: Source<NetworkEntry> = {
      take: (match) => capture.take(match),
      restore: (entries) => capture.restore(entries),
      size: () => capture.size(),
      pending: () => capture.pending(),
      scrub: (entry) => redactKnown(entry, redactor),
    };

    running.network.set(
      tabId,
      hold(tabId, owner, source, () => Promise.resolve(capture.stop())),
    );
  };

  const disable = (tabId: number) =>
    Promise.all(
      ['Runtime.disable', 'Log.disable'].map((method) =>
        cdp.send(tabId, method, {}).catch(() => undefined),
      ),
    ).then(() => undefined);

  const startConsole = async (tabId: number, owner: string, signal: AbortSignal) => {
    const frameId = await mainFrame(tabId, signal);
    const redactor = redactorFor(tabId);
    const capture = captureConsole({ cdp, tabId, frameId, redactor });
    const source: Source<ConsoleEntry> = {
      take: (match) => capture.take(match),
      restore: (entries) => capture.restore(entries),
      size: () => capture.size(),
      pending: () => 0,
      scrub: (entry) => ({ ...entry, text: redactor.redactText(entry.text) }),
    };

    const entry = hold(tabId, owner, source, () => {
      capture.stop();

      return disable(tabId);
    });

    running.console.set(tabId, entry);

    try {
      await sessions.send(tabId, 'Runtime.enable', {}, signal);
      await sessions.send(tabId, 'Log.enable', {}, signal);
    } catch (error) {
      await entry.stop();
      running.console.delete(tabId);

      throw error;
    }
  };

  const take = <T>(
    capture: Running<T>,
    { match, fit }: ReadOptions<T> = {},
    into: Source<T> = capture,
  ): CaptureRead<T> => {
    const taken = capture.take(match);
    const scrubbed = taken.entries.map((item) => capture.scrub(item));
    const room = fit ? Math.min(scrubbed.length, Math.max(fit(scrubbed), 1)) : scrubbed.length;
    const left = scrubbed.length - room;

    into.restore(taken.entries.slice(0, left));

    return {
      entries: scrubbed.slice(left),
      dropped: taken.dropped,
      capturing: !capture.ended && !capture.stopped,
      pending: capture.pending(),
      left,
      ...(capture.ended ? { ended: capture.ended } : {}),
    };
  };

  const settle = (tabId: number, kind: CaptureKind) => {
    const capture = running[kind].get(tabId);

    if (capture && (capture.ended || capture.stopped) && capture.size() === 0) forget(tabId, kind);
  };

  const unsubscribe = cdp.onDetach((tabId, reason) =>
    end(tabId, DETACH_REASONS[reason] ?? 'detached'),
  );

  return {
    start: async (tabId, kind, { bodies = false, owner, fit }, signal) => {
      const current = running[kind].get(tabId);

      if (current && !current.ended && !current.stopped) return { started: false };

      await sessions.ensure(tabId, signal);

      try {
        if (kind === 'network') await startNetwork(tabId, owner, bodies, signal);
        else await startConsole(tabId, owner, signal);
      } catch (error) {
        if (current) running[kind].set(tabId, current);

        throw error;
      }

      const next = running[kind].get(tabId);
      const previous = current && next && take(current, { fit }, next);

      return { started: true, ...(previous ? { previous } : {}) };
    },
    read: (tabId, kind, options) => {
      const capture = running[kind].get(tabId);

      if (!capture) return undefined;

      const read = take(capture, options);

      settle(tabId, kind);

      return read;
    },
    stop: async (tabId, kind, options) => {
      const capture = running[kind].get(tabId);

      if (!capture) return undefined;

      await capture.stop();
      capture.stopped = true;

      const read = take(capture, options);

      settle(tabId, kind);

      return read;
    },
    owner: (tabId, kind) => running[kind].get(tabId)?.owner,
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
