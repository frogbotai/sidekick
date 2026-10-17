import {
  agents,
  answerContent,
  callFrame,
  chromeCdp,
  chromePage,
  chromeTabs,
  cleanupLegacy,
  contentProtocol,
  createBrowserRuntime,
  createBrowserWorker,
  createPermissionEngine,
  createToolBridge,
  frameProtocol,
  permissionModes,
  registerBuiltinAgents,
  registerBuiltinModes,
  restrictStorageToTrustedContexts,
  serve,
  type Server,
  sidekickProtocol,
  tools,
} from '@frogbotai/sidekick-core';
import { listenForConnect } from '@frogbotai/sidekick-core/frogbot';
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

  registerBuiltinAgents();
  registerBuiltinModes();

  let server: Server<typeof sidekickProtocol> | undefined;

  const browser = createBrowserWorker(runtime);

  const permission = createPermissionEngine({
    agents,
    modes: permissionModes,
    emit: (type, data) => server?.emit(type, data),
  });

  const bridge = createToolBridge({ tools, permission, run: browser.sessionRun });

  tools.register('builtin', (draft) => {
    for (const tool of runtime.tools) draft.add(tool);
  });

  server = serve(
    sidekickProtocol,
    {
      'tab.ping': async (target) => {
        const { url } = await callFrame(frameProtocol, target, 'frame.ping', {});

        return { frameId: target.frameId, url, bootId };
      },
      ...browser.handlers,
      'run.end': (input) => {
        if (input.close) permission.close(input.sessionID);

        return browser.handlers['run.end'](input);
      },
      ...bridge,
    },
    { bootId },
  );

  browser.connect(server);
  answerContent(contentProtocol, browser.content);

  if (import.meta.env.SIDEKICK_E2E) answerTestRequests(runtime);

  void runtime.start();

  listenForConnect();

  chrome.runtime.onInstalled.addListener((details) => {
    void cleanupLegacy(details);

    if (details.reason === 'install' || details.reason === 'update') void injectIntoOpenTabs();
  });
});
