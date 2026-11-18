import type { Runs } from './runs';
import type { Sessions } from './sessions';
import type { Cdp } from './types';

/** A tab's viewport override, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
  device_scale_factor?: number;
  mobile?: boolean;
}

/** A tab's location override, in degrees and metres. */
export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/** The overrides active on one tab. Media features merge, so setting one keeps the other. */
export interface Overrides {
  viewport?: Viewport;
  color_scheme?: 'light' | 'dark';
  reduced_motion?: 'reduce' | 'no-preference';
  user_agent?: string;
  geolocation?: Geolocation;
}

export interface Emulation {
  /** Merges `overrides` into the tab's, sends them, and holds the tab's debugger session while any remain. */
  set(input: {
    tabId: number;
    runId: string;
    overrides: Overrides;
    signal?: AbortSignal;
  }): Promise<Overrides>;
  /** Clears every override on the tab. */
  reset(tabId: number, signal?: AbortSignal): Promise<void>;
  active(tabId: number): Overrides;
  /** Clears the overrides a run set, when it ends or hands its tabs back. */
  release(runId: string): Promise<void>;
  dispose(): void;
}

interface Entry {
  runId: string;
  overrides: Overrides;
}

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const MEDIA = { color_scheme: 'prefers-color-scheme', reduced_motion: 'prefers-reduced-motion' };

function mediaOf(overrides: Overrides) {
  return {
    features: (['color_scheme', 'reduced_motion'] as const).flatMap((key) => {
      const value = overrides[key];

      return value === undefined ? [] : [{ name: MEDIA[key], value }];
    }),
  };
}

function hasMedia(overrides: Overrides) {
  return overrides.color_scheme !== undefined || overrides.reduced_motion !== undefined;
}

async function apply(send: Send, overrides: Overrides, changed: Overrides = overrides) {
  const { viewport, user_agent, geolocation } = overrides;

  if (changed.viewport && viewport) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.device_scale_factor ?? 0,
      mobile: viewport.mobile ?? false,
    });
  }

  if (hasMedia(changed)) await send('Emulation.setEmulatedMedia', mediaOf(overrides));

  if (changed.user_agent && user_agent) {
    await send('Emulation.setUserAgentOverride', { userAgent: user_agent });
  }

  if (changed.geolocation && geolocation) {
    await send('Emulation.setGeolocationOverride', {
      latitude: geolocation.latitude,
      longitude: geolocation.longitude,
      accuracy: geolocation.accuracy ?? 10,
    });
  }
}

async function clear(send: Send) {
  await send('Emulation.clearDeviceMetricsOverride', {});
  await send('Emulation.clearDeviceMetricsOverride', {});
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setUserAgentOverride', { userAgent: '' });
  await send('Emulation.clearGeolocationOverride', {});
}

function isEmpty(overrides: Overrides) {
  return Object.values(overrides).every((value) => value === undefined);
}

export function createEmulation({
  cdp,
  sessions,
  runs,
}: {
  cdp: Cdp;
  sessions: Sessions;
  runs: Runs;
}): Emulation {
  const entries = new Map<number, Entry>();

  const forget = (tabId: number) => {
    entries.delete(tabId);
    sessions.hold(tabId, false);
  };

  const reset = async (tabId: number, signal?: AbortSignal) => {
    const known = entries.has(tabId);

    forget(tabId);

    if (!known && !sessions.attached(tabId)) return;

    await clear((method, params) => sessions.send(tabId, method, params, signal));
  };

  const release = async (runId: string) => {
    const tabs = [...entries].filter(([, entry]) => entry.runId === runId).map(([tabId]) => tabId);

    await Promise.all(
      tabs.map(async (tabId) => {
        forget(tabId);

        if (!sessions.attached(tabId)) return;

        await clear((method, params) => sessions.send(tabId, method, params)).catch(
          () => undefined,
        );
      }),
    );
  };

  const unsubscribers = [
    sessions.onAttached(async (tabId) => {
      const entry = entries.get(tabId);

      if (entry) await apply((method, params) => cdp.send(tabId, method, params), entry.overrides);
    }),
    runs.onStopped(({ runId }) => void release(runId)),
    cdp.onDetach((tabId, reason) => {
      if (reason === 'target_closed') forget(tabId);
    }),
  ];

  return {
    set: async ({ tabId, runId, overrides, signal }) => {
      const before = entries.get(tabId);
      const merged = { ...before?.overrides, ...overrides };

      if (isEmpty(merged)) return {};

      await sessions.ensure(tabId, signal);
      entries.set(tabId, { runId, overrides: merged });
      sessions.hold(tabId, true);

      try {
        await apply(
          (method, params) => sessions.send(tabId, method, params, signal),
          merged,
          overrides,
        );
      } catch (error) {
        if (before) entries.set(tabId, before);
        else forget(tabId);

        throw error;
      }

      return merged;
    },
    reset,
    active: (tabId) => entries.get(tabId)?.overrides ?? {},
    release,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
