import type { BrowserContext, Page } from '@playwright/test';

import type { SidekickWorker } from '../src/entrypoints/sidepanel/worker';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    sidekick: { worker: SidekickWorker };
    boots?: string[];
  }
}

const ORIGIN = 'https://fixture.sidekick.test';

async function openFixture(context: BrowserContext) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());

    return route.fulfill({
      contentType: 'text/html',
      body:
        pathname === '/frame.html'
          ? '<title>Frame</title><p>inner</p>'
          : '<title>Top</title><iframe src="/frame.html"></iframe>',
    });
  });

  const page = await context.newPage();

  await page.goto(`${ORIGIN}/`);
  await expect(page.frameLocator('iframe').locator('p')).toHaveText('inner');

  return page;
}

async function connectedPanel(openPanel: () => Promise<Page>) {
  const panel = await openPanel();

  await panel.waitForFunction(() => 'sidekick' in window);

  return panel;
}

async function fixtureTabId(panel: Page) {
  const tabId = await panel.evaluate(
    async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0]?.id,
    ORIGIN,
  );

  if (tabId === undefined) throw new Error('No fixture tab');

  return tabId;
}

function ping(panel: Page, tabId: number, frameId: number) {
  return panel.evaluate((target) => window.sidekick.worker.call('tab.ping', target), {
    tabId,
    frameId,
  });
}

test('pings the top frame and a same-origin iframe from the panel', async ({
  context,
  openPanel,
}) => {
  await openFixture(context);

  const panel = await connectedPanel(openPanel);
  const tabId = await fixtureTabId(panel);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  const frames = await worker.evaluate(
    async (id) => (await chrome.webNavigation.getAllFrames({ tabId: id })) ?? [],
    tabId,
  );

  const child = frames.find((frame) => frame.parentFrameId === 0);

  if (!child) throw new Error('No iframe');

  const top = await ping(panel, tabId, 0);

  expect(top).toEqual({ frameId: 0, url: `${ORIGIN}/`, bootId: expect.any(String) });

  expect(await ping(panel, tabId, child.frameId)).toEqual({
    frameId: child.frameId,
    url: `${ORIGIN}/frame.html`,
    bootId: top.bootId,
  });
});

test('reconnects with a new bootId after the worker is stopped', async ({ context, openPanel }) => {
  await openFixture(context);

  const panel = await connectedPanel(openPanel);
  const tabId = await fixtureTabId(panel);
  const before = await ping(panel, tabId, 0);

  await panel.evaluate(() => {
    window.boots = [];
    window.sidekick.worker.on('worker.connected', ({ bootId }) => window.boots?.push(bootId));
  });

  const cdp = await context.newCDPSession(panel);

  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');

  await expect.poll(() => panel.evaluate(() => window.boots?.length)).toBe(1);

  const boot = await panel.evaluate(() => window.boots?.[0]);

  expect(boot).not.toBe(before.bootId);
  expect(await ping(panel, tabId, 0)).toEqual({ ...before, bootId: boot });
});

async function contentScriptWorld(context: BrowserContext, page: Page, extensionId: string) {
  const cdp = await context.newCDPSession(page);
  const contexts: { id: number; origin: string; auxData?: { type?: string } }[] = [];

  cdp.on('Runtime.executionContextCreated', ({ context: created }) => contexts.push(created));
  await cdp.send('Runtime.enable');

  const isolated = () =>
    contexts.find(
      (created) =>
        created.origin === `chrome-extension://${extensionId}` &&
        created.auxData?.type === 'isolated',
    );

  await expect.poll(isolated).toBeDefined();

  const evaluate = (expression: string) =>
    cdp.send('Runtime.evaluate', {
      contextId: isolated()?.id,
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

  expect((await evaluate('chrome.runtime.id')).result.value).toBe(extensionId);

  return evaluate;
}

test('content scripts cannot read storage.local', async ({ context, extensionId, openPanel }) => {
  const page = await openFixture(context);
  const panel = await openPanel();

  await panel.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));

  const evaluate = await contentScriptWorld(context, page, extensionId);
  const read = await evaluate('chrome.storage.local.get("theme")');

  expect(read.exceptionDetails?.exception?.description).toContain(
    'Access to storage is not allowed from this context',
  );
});

test('the worker disconnects a port opened by a content script', async ({
  context,
  extensionId,
}) => {
  const page = await openFixture(context);
  const evaluate = await contentScriptWorld(context, page, extensionId);

  const outcome = await evaluate(`new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'sidekick' });
    const messages = [];
    port.onMessage.addListener((message) => messages.push(message));
    port.onDisconnect.addListener(() => resolve({ disconnected: true, messages }));
    port.postMessage({ kind: 'request', id: '1', method: 'tab.ping', input: { tabId: 1, frameId: 0 } });
  })`);

  expect(outcome.result.value).toEqual({ disconnected: true, messages: [] });
});
