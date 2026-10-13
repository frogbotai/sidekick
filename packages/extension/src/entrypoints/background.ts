import {
  answerContent,
  callFrame,
  chromeCdp,
  chromePage,
  chromeTabs,
  contentProtocol,
  createBrowserRuntime,
  createBrowserWorker,
  frameProtocol,
  restrictStorageToTrustedContexts,
  serve,
  sidekickProtocol,
  tools,
} from '@frogbotai/sidekick-core';
import { defineBackground } from 'wxt/utils/define-background';

import { answerTestRequests } from '../testTools';

const FRAME_SCRIPT = 'frame.js';

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });

  await Promise.allSettled(
    tabs.map((tab) =>
      tab.id === undefined
        ? Promise.resolve()
        : chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: [FRAME_SCRIPT],
          }),
    ),
  );
}

async function injectFrame(tabId: number, frameId: number) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: [FRAME_SCRIPT],
  });
}

export default defineBackground(() => {
  void restrictStorageToTrustedContexts();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  const bootId = crypto.randomUUID();
  const tabs = chromeTabs();

  const runtime = createBrowserRuntime({
    cdp: chromeCdp(),
    page: chromePage({ tabs, inject: injectFrame }),
    tabs,
    mac: /Mac OS X|Macintosh/.test(navigator.userAgent),
  });

  const browser = createBrowserWorker(runtime);

  tools.register('builtin', (draft) => {
    for (const tool of runtime.tools) draft.add(tool);
  });

  const server = serve(
    sidekickProtocol,
    {
      'tab.ping': async (target) => {
        const { url } = await callFrame(frameProtocol, target, 'frame.ping', {});

        return { frameId: target.frameId, url, bootId };
      },
      ...browser.handlers,
    },
    { bootId },
  );

  browser.connect(server);
  answerContent(contentProtocol, browser.content);

  if (import.meta.env.SIDEKICK_E2E) answerTestRequests(runtime);

  void runtime.start();

  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install' || reason === 'update') void injectIntoOpenTabs();
  });
});
