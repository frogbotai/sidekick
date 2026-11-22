import { ToolError } from '../../tool/tool';
import type { Runs } from './runs';
import type { Sessions } from './sessions';
import type { Cdp, Tabs } from './types';

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

interface Group {
  keys: (keyof Overrides)[];
  apply(send: Send, overrides: Overrides): Promise<unknown>;
}

const GROUPS: Group[] = [
  {
    keys: ['viewport'],
    apply: (send, { viewport }) =>
      send('Emulation.setDeviceMetricsOverride', {
        width: viewport?.width,
        height: viewport?.height,
        deviceScaleFactor: viewport?.device_scale_factor ?? 0,
        mobile: viewport?.mobile ?? false,
      }),
  },
  {
    keys: ['color_scheme', 'reduced_motion'],
    apply: (send, overrides) =>
      send('Emulation.setEmulatedMedia', {
        features: (['color_scheme', 'reduced_motion'] as const).flatMap((key) => {
          const value = overrides[key];

          return value === undefined ? [] : [{ name: MEDIA[key], value }];
        }),
      }),
  },
  {
    keys: ['user_agent'],
    apply: (send, { user_agent }) =>
      send('Emulation.setUserAgentOverride', { userAgent: user_agent }),
  },
  {
    keys: ['geolocation'],
    apply: (send, { geolocation }) =>
      send('Emulation.setGeolocationOverride', {
        latitude: geolocation?.latitude,
        longitude: geolocation?.longitude,
        accuracy: geolocation?.accuracy ?? 10,
      }),
  },
];

function touches(group: Group, overrides: Overrides) {
  return group.keys.some((key) => overrides[key] !== undefined);
}

async function apply(send: Send, overrides: Overrides, changed: Overrides = overrides) {
  for (const group of GROUPS) {
    if (touches(group, changed)) await group.apply(send, overrides);
  }
}

async function reapply(send: Send, overrides: Overrides) {
  let applied = overrides;

  for (const group of GROUPS.filter((each) => touches(each, overrides))) {
    try {
      await group.apply(send, overrides);
    } catch {
      applied = Object.fromEntries(
        Object.entries(applied).filter(([key]) => !group.keys.some((each) => each === key)),
      );
    }
  }

  return applied;
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
  tabs,
}: {
  cdp: Cdp;
  sessions: Sessions;
  runs: Runs;
  tabs: Tabs;
}): Emulation {
  const entries = new Map<number, Entry>();
  const releases = new Map<string, number>();
  const holds = new Map<number, () => void>();

  const forget = (tabId: number) => {
    entries.delete(tabId);
    holds.get(tabId)?.();
    holds.delete(tabId);
  };

  const reset = async (tabId: number, signal?: AbortSignal) => {
    const known = entries.has(tabId);

    forget(tabId);

    if (!known && !sessions.attached(tabId)) return;

    await clear((method, params) => sessions.send(tabId, method, params, signal));
  };

  const release = async (runId: string) => {
    releases.set(runId, (releases.get(runId) ?? 0) + 1);

    const held = [...entries].filter(([, entry]) => entry.runId === runId).map(([tabId]) => tabId);

    await Promise.all(
      held.map(async (tabId) => {
        forget(tabId);

        if (!sessions.attached(tabId)) return;

        await clear((method, params) => sessions.send(tabId, method, params)).catch(
          () => undefined,
        );
      }),
    );
  };

  const rollback = async (tabId: number, before: Entry | undefined) => {
    if (before) entries.set(tabId, before);
    else forget(tabId);

    const send: Send = (method, params) => sessions.send(tabId, method, params);

    await clear(send)
      .then(() => before && apply(send, before.overrides))
      .catch(() => undefined);
  };

  const unsubscribers = [
    sessions.onAttached(async (tabId) => {
      const entry = entries.get(tabId);

      if (!entry) return;

      const applied = await reapply(
        (method, params) => cdp.send(tabId, method, params),
        entry.overrides,
      );

      if (entries.get(tabId) !== entry) return;

      if (isEmpty(applied)) forget(tabId);
      else entry.overrides = applied;
    }),
    runs.onStopped(({ runId }) => void release(runId)),
    cdp.onDetach((tabId, reason) => {
      if (reason !== 'target_closed') return;

      void tabs.get(tabId).catch(() => {
        if (entries.has(tabId)) forget(tabId);
      });
    }),
  ];

  return {
    set: async ({ tabId, runId, overrides, signal }) => {
      const before = entries.get(tabId);
      const merged = { ...before?.overrides, ...overrides };

      if (isEmpty(merged)) return {};

      const epoch = releases.get(runId);

      await sessions.ensure(tabId, signal);

      if (releases.get(runId) !== epoch) {
        throw new ToolError(
          'stopped',
          'The task handed this tab back before the emulation applied, so nothing changed.',
        );
      }

      const entry = { runId, overrides: merged };

      entries.set(tabId, entry);
      if (!holds.has(tabId)) holds.set(tabId, sessions.hold(tabId));

      try {
        await apply(
          (method, params) => sessions.send(tabId, method, params, signal),
          merged,
          overrides,
        );
      } catch (error) {
        if (entries.get(tabId) === entry) await rollback(tabId, before);

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
