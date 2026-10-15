import type { Capture, Cdp, CdpEvent, TabInfo, Tabs } from './types';

const PROTOCOL_VERSION = '1.3';

const QUALITY = 80;

function record(params: object | undefined): Record<string, unknown> {
  return params ? Object.fromEntries(Object.entries(params)) : {};
}

function listen<A extends unknown[]>(
  event: chrome.events.Event<(...args: A) => void>,
  listener: (...args: A) => void,
) {
  event.addListener(listener);

  return () => event.removeListener(listener);
}

export function chromeCdp(): Cdp {
  return {
    attach: (tabId) => chrome.debugger.attach({ tabId }, PROTOCOL_VERSION),
    detach: (tabId) => chrome.debugger.detach({ tabId }),
    send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
    attachedTabs: async () =>
      (await chrome.debugger.getTargets()).flatMap((target) =>
        target.attached && target.tabId !== undefined ? [target.tabId] : [],
      ),
    onEvent: (listener) =>
      listen(chrome.debugger.onEvent, (source, method, params) => {
        if (source.tabId === undefined) return;

        const event: CdpEvent = { tabId: source.tabId, method, params: record(params) };

        listener(event);
      }),
    onDetach: (listener) =>
      listen(chrome.debugger.onDetach, (source, reason) => {
        if (source.tabId !== undefined) listener(source.tabId, reason);
      }),
  };
}

function info(tab: chrome.tabs.Tab): TabInfo {
  if (tab.id === undefined) throw new Error('The tab has no id');

  return {
    id: tab.id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    url: tab.url ?? '',
    pendingUrl: tab.pendingUrl,
    title: tab.title ?? '',
    active: tab.active,
  };
}

function base64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

async function captureVisible(windowId: number, scale: number): Promise<Capture> {
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: QUALITY });
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');

  if (!context) throw new Error('No 2D canvas for the screenshot');

  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY / 100 });

  return { data: base64(await blob.arrayBuffer()), mime: 'image/jpeg', width, height };
}

function waitForLoad(tabId: number, timeout: number) {
  return new Promise<boolean>((resolve) => {
    const done = (loaded: boolean) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
      resolve(loaded);
    };

    const onUpdated = (id: number, change: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id === tabId && (change.status === 'complete' || tab.status === 'complete')) done(true);
    };

    const onCompleted = ({ tabId: id, frameId }: { tabId: number; frameId: number }) => {
      if (id === tabId && frameId === 0) done(true);
    };

    const timer = setTimeout(() => done(false), timeout);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.webNavigation.onCompleted.addListener(onCompleted);

    void chrome.tabs.get(tabId).then(
      (tab) => tab.status === 'complete' && done(true),
      () => done(false),
    );
  });
}

export function chromeTabs(): Tabs {
  return {
    get: async (tabId) => info(await chrome.tabs.get(tabId)),
    active: async (windowId) => {
      const [tab] = await chrome.tabs.query({ active: true, windowId });

      if (!tab) throw new Error(`Window ${windowId} has no active tab`);

      return info(tab);
    },
    inGroup: async (groupId) => (await chrome.tabs.query({ groupId })).map(info),
    create: async (input) => info(await chrome.tabs.create(input)),
    group: (tabId, groupId) => chrome.tabs.group({ tabIds: tabId, groupId }),
    label: async (groupId, title) => void (await chrome.tabGroups.update(groupId, { title })),
    activate: async (tabId) => {
      const tab = await chrome.tabs.update(tabId, { active: true });

      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    },
    navigate: async (tabId, url) => void (await chrome.tabs.update(tabId, { url })),
    history: (tabId, go) =>
      go === 'back'
        ? chrome.tabs.goBack(tabId)
        : go === 'forward'
          ? chrome.tabs.goForward(tabId)
          : chrome.tabs.reload(tabId),
    close: (tabId) => chrome.tabs.remove(tabId),
    frames: async (tabId) =>
      ((await chrome.webNavigation.getAllFrames({ tabId })) ?? []).map(
        ({ frameId, parentFrameId, url }) => ({
          frameId,
          parentFrameId,
          url,
        }),
      ),
    waitForLoad,
    captureVisible,
    onOpened: (listener) =>
      listen(chrome.webNavigation.onCreatedNavigationTarget, ({ tabId, sourceTabId }) =>
        listener({ id: tabId, sourceTabId }),
      ),
    onGroupRemoved: (listener) => listen(chrome.tabGroups.onRemoved, (group) => listener(group.id)),
  };
}
