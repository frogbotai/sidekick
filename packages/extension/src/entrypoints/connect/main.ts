import '@frogbotai/ui/fonts.css';
import '@frogbotai/ui/styles.css';
import '../sidepanel/panel.css';

import { connectWorker, sidekickProtocol, theme } from '@frogbotai/sidekick-core';

import { followPageTheme } from '../../theme/pageTheme';
import { type ConnectView, runConnectPage } from './connect';

followPageTheme(await theme.get(), theme.watch);

const status = document.getElementById('status');
const detail = document.getElementById('detail');
const approve = document.getElementById('approve');
const settings = document.getElementById('settings');

const worker = connectWorker(sidekickProtocol);

function failed(error: unknown): ConnectView {
  return {
    text: `Sidekick couldn’t connect: ${error instanceof Error ? error.message : String(error)}`,
    settings: false,
  };
}

async function show(view: ConnectView) {
  if (status) status.textContent = view.text;

  if (detail) {
    detail.textContent = view.detail ?? '';
    detail.hidden = !view.detail;
  }

  if (settings) settings.hidden = !view.settings;

  if (approve instanceof HTMLButtonElement) {
    approve.hidden = !view.approve;
    approve.disabled = false;

    approve.onclick = view.approve
      ? () => {
          approve.disabled = true;
          void view.approve?.().catch(failed).then(show);
        }
      : null;
  }

  if (view.close) {
    const tab = await chrome.tabs.getCurrent();

    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
  }
}

await show(
  await runConnectPage({
    href: location.href,
    replaceUrl: (url) => history.replaceState(null, '', url),
    tabId: async () => (await chrome.tabs.getCurrent())?.id,
    connect: (input) => worker.call('mcp.connect', input, { timeout: false }),
    shown: ({ hub, pair }) => {
      const url = new URL(hub);

      url.searchParams.set('pair', pair);
      url.searchParams.set('shown', '1');

      const socket = new WebSocket(url);

      socket.onopen = () => socket.close();
    },
    pair: (input) => worker.call('mcp.pair', input, { timeout: false }),
    unpair: (input) => worker.call('mcp.unpair', input, { timeout: false }),
  }).catch(failed),
);
