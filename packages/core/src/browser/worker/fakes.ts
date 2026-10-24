import type { PermissionRequest, ToolContext, ToolMetadata } from '../../tool/tool';
import type { Cdp, CdpEvent, Commit, Page, Size, TabInfo, Tabs } from './types';

export type Log = string[];

export interface SentCommand {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

function logged<T extends object>(log: Log, prefix: string, target: T): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);

      if (typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        log.push(`${prefix}.${String(key)}`);

        return Reflect.apply(value, object, args);
      };
    },
  });
}

/** Runs `fn` as a promise, so a throw becomes a rejection. */
export function later<A extends unknown[], R>(fn: (...args: A) => R) {
  return (...args: A) => new Promise<R>((resolve) => resolve(fn(...args)));
}

function emitter<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();

  return {
    add: (listener: (...args: A) => void) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
    emit: (...args: A) => {
      for (const listener of [...listeners]) listener(...args);
    },
    size: () => listeners.size,
  };
}

/** A base64 JPEG that is only a start-of-frame header at `width` × `height`. */
export function fakeJpeg({ width, height }: Size) {
  const start = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
  const size = [height >> 8, height & 0xff, width >> 8, width & 0xff];
  const components = [0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const bytes = [...start, ...size, ...components, 0xff, 0xd9];

  return btoa(String.fromCharCode(...bytes));
}

function clipOf(params: Record<string, unknown>) {
  const clip = params.clip;

  if (typeof clip !== 'object' || !clip) return { width: 1, height: 1, scale: 1 };

  const number = (key: string, fallback: number) => {
    const value: unknown = Reflect.get(clip, key);

    return typeof value === 'number' ? value : fallback;
  };

  return { width: number('width', 1), height: number('height', 1), scale: number('scale', 1) };
}

export interface FakeCdp extends Cdp {
  sent: SentCommand[];
  attaching: number[];
  detached: number[];
  sessions: Set<number>;
  leftover: number[];
  attachErrors: Error[];
  sendErrors: Map<string, Error[]>;
  replies: Map<string, (params: Record<string, unknown>) => unknown>;
  emit: (event: CdpEvent) => void;
  detachByChrome: (tabId: number, reason: string) => void;
  listeners: () => number;
  /** The screen's device pixel ratio: `Page.captureScreenshot` renders clip × scale × ratio. */
  ratio: number;
}

export function fakeCdp(log: Log): FakeCdp {
  const events = emitter<[CdpEvent]>();
  const detaches = emitter<[number, string]>();

  const fake: FakeCdp = {
    sent: [],
    attaching: [],
    detached: [],
    sessions: new Set(),
    leftover: [],
    attachErrors: [],
    sendErrors: new Map(),
    replies: new Map<string, (params: Record<string, unknown>) => unknown>([
      [
        'Page.getLayoutMetrics',
        () => ({
          cssVisualViewport: { pageX: 0, pageY: 500, clientWidth: 800, clientHeight: 600 },
          visualViewport: { clientWidth: 800 * fake.ratio },
        }),
      ],
      [
        'Page.captureScreenshot',
        (params) => {
          const { width, height, scale } = clipOf(params);
          const pixels = scale * fake.ratio;

          return {
            data: fakeJpeg({
              width: Math.round(width * pixels),
              height: Math.round(height * pixels),
            }),
          };
        },
      ],
    ]),
    attach: later((tabId: number) => {
      log.push('cdp.attach');
      fake.attaching.push(tabId);

      const error = fake.attachErrors.shift();

      if (error !== undefined) throw error;

      fake.sessions.add(tabId);
    }),
    detach: later((tabId: number) => {
      log.push('cdp.detach');
      fake.detached.push(tabId);
      fake.sessions.delete(tabId);
    }),
    send: later((tabId: number, method: string, params: Record<string, unknown> = {}) => {
      log.push(`cdp.${method}`);
      fake.sent.push({ tabId, method, params });

      const error = fake.sendErrors.get(method)?.shift();

      if (error !== undefined) throw error;

      if (!fake.sessions.has(tabId)) {
        throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      }

      return fake.replies.get(method)?.(params) ?? {};
    }),
    attachedTabs: later(() => [...fake.leftover]),
    onEvent: events.add,
    onDetach: detaches.add,
    emit: events.emit,
    detachByChrome: (tabId, reason) => {
      fake.sessions.delete(tabId);
      detaches.emit(tabId, reason);
    },
    listeners: events.size,
    ratio: 1,
  };

  return fake;
}

export function fakePage(log: Log, overrides: Partial<Page> = {}): Page {
  const page: Page = {
    key: 'worker-key',
    snapshot: later(() => ({
      title: 'Example',
      text: '- button "Go" [f0e1]',
      redacted: 0,
      truncated: false,
    })),
    inspect: later(() => ({
      frameId: 0,
      frameOrigin: 'https://example.com',
      redacted: false,
      role: 'button',
      name: 'Sign in',
    })),
    scrollTo: later(() => ({
      point: { x: 100, y: 200 },
      rect: { x: 50, y: 150, width: 100, height: 100 },
      in_view: true,
    })),
    focus: later(() => undefined),
    selectContents: later(() => undefined),
    readValue: later(() => ''),
    selectOptions: later((_tabId: number, _ref: string, values: string[]) => values),
    scrollStart: later(() => ({
      token: 't1',
      container: 'document',
      point: { x: 400, y: 300 },
      delta: { x: 0, y: 480 },
    })),
    scrollEnd: later(() => ({ moved: 480, at_end: false })),
    scrollFallback: later(() => ({ moved: 480, at_end: false })),
    domQuiet: later(() => true),
    viewport: later(() => ({ width: 800, height: 600 })),
    iframes: later(() => []),
    strip: later(() => []),
    indicator: later(() => undefined),
    ...overrides,
  };

  return logged(log, 'page', page);
}

export interface FakeTabs extends Tabs {
  tabs: Map<number, TabInfo>;
  createTab: (tab: Partial<TabInfo> & { id: number; sourceTabId?: number }) => void;
  removeGroup: (groupId: number) => void;
  /** What `navigate` and `history` do after they return: commit a new document (the default), nothing, or fail. */
  navigation: 'commit' | 'none' | { error: string };
  commit: (commit: Partial<Commit> & { tabId: number }) => void;
  failNavigation: (tabId: number, error: string) => void;
}

export function fakeTabs(log: Log, initial: TabInfo[]): FakeTabs {
  const tabs = new Map(initial.map((tab) => [tab.id, { ...tab }]));
  const opened = emitter<[{ id: number; sourceTabId: number }]>();
  const groupsRemoved = emitter<[number]>();
  const commits = emitter<[Commit]>();
  const errors = emitter<[{ tabId: number; error: string }]>();
  let nextGroup = 100;
  let nextTab = 1000;

  const tab = (tabId: number) => {
    const found = tabs.get(tabId);

    if (!found) throw new Error(`No tab with id: ${tabId}.`);

    return found;
  };

  const navigated = (tabId: number) => {
    const { navigation } = fake;

    if (navigation === 'none') return;

    if (navigation === 'commit') fake.commit({ tabId });
    else fake.failNavigation(tabId, navigation.error);
  };

  const fake: FakeTabs = {
    tabs,
    navigation: 'commit',
    get: later((tabId: number) => ({ ...tab(tabId) })),
    active: later((windowId: number) => {
      const found = [...tabs.values()].find((entry) => entry.windowId === windowId && entry.active);

      if (!found) throw new Error(`Window ${windowId} has no active tab`);

      return { ...found };
    }),
    inGroup: later((groupId: number) =>
      [...tabs.values()].filter((entry) => entry.groupId === groupId),
    ),
    create: later(
      ({ windowId, url, active }: { windowId: number; url: string; active: boolean }) => {
        const opened = { id: nextTab++, windowId, groupId: -1, url, title: '', active };

        tabs.set(opened.id, opened);

        return { ...opened };
      },
    ),
    group: later((tabId: number, groupId?: number) => {
      const id = groupId ?? nextGroup++;

      tab(tabId).groupId = id;

      return id;
    }),
    label: later(() => undefined),
    activate: later((tabId: number) => {
      for (const entry of tabs.values()) entry.active = entry.id === tabId;
    }),
    navigate: later((tabId: number, url: string) => {
      const entry = tab(tabId);

      entry.url = url;
      delete entry.pendingUrl;
      navigated(tabId);
    }),
    history: later((tabId: number) => navigated(tabId)),
    close: later((tabId: number) => {
      tabs.delete(tabId);
    }),
    frames: later(() => [{ frameId: 0, parentFrameId: -1, url: 'https://example.com/' }]),
    waitForLoad: later(() => true),
    captureVisible: later((_windowId: number, size: Size) => ({
      data: fakeJpeg(size),
      mime: 'image/jpeg',
      ...size,
    })),
    onOpened: opened.add,
    onGroupRemoved: groupsRemoved.add,
    onCommitted: commits.add,
    onNavigationError: errors.add,
    commit: ({ tabId, url, sameDocument = false }) =>
      commits.emit({ tabId, url: url ?? tab(tabId).url, sameDocument }),
    failNavigation: (tabId, error) => errors.emit({ tabId, error }),
    createTab: ({ sourceTabId, ...entry }) => {
      tabs.set(entry.id, {
        windowId: 1,
        groupId: -1,
        url: 'about:blank',
        title: '',
        active: false,
        ...entry,
      });

      if (sourceTabId !== undefined) opened.emit({ id: entry.id, sourceTabId });
    },
    removeGroup: (groupId) => {
      for (const entry of tabs.values()) if (entry.groupId === groupId) entry.groupId = -1;

      groupsRemoved.emit(groupId);
    },
  };

  return logged(log, 'tabs', fake);
}

export interface FakeContext extends ToolContext {
  asserts: PermissionRequest[];
  /** Every progress report, in order. */
  reports: ToolMetadata[];
  controller: AbortController;
}

export function fakeContext(log: Log, runId: string): FakeContext {
  const controller = new AbortController();
  const asserts: PermissionRequest[] = [];
  const reports: ToolMetadata[] = [];

  return {
    signal: controller.signal,
    controller,
    session: { id: 'session-1' },
    messageID: 'message-1',
    callID: 'call-1',
    agent: 'build',
    run: { id: runId },
    asserts,
    reports,
    progress: (metadata) => {
      reports.push(metadata);

      return Promise.resolve();
    },
    permission: {
      assert: later((request: PermissionRequest) => {
        log.push(`assert.${request.action}`);
        asserts.push(request);
      }),
    },
  };
}
