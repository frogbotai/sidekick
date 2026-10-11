import {
  callFrame,
  frameProtocol,
  restrictStorageToTrustedContexts,
  serve,
  sidekickProtocol,
} from '@frogbotai/sidekick-core';
import { defineBackground } from 'wxt/utils/define-background';

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

export default defineBackground(() => {
  void restrictStorageToTrustedContexts();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  const bootId = crypto.randomUUID();

  serve(
    sidekickProtocol,
    {
      'tab.ping': async (target) => {
        const { url } = await callFrame(frameProtocol, target, 'frame.ping', {});

        return { frameId: target.frameId, url, bootId };
      },
    },
    { bootId },
  );

  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install' || reason === 'update') void injectIntoOpenTabs();
  });
});
