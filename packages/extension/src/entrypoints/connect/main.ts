import '@frogbotai/ui/styles.css';
import '../sidepanel/panel.css';

import { connectWorker, sidekickProtocol, theme } from '@frogbotai/sidekick-core';

import { followPageTheme } from '../../theme/pageTheme';
import { type ConnectView, runConnectPage } from './connect';

followPageTheme(await theme.get(), theme.watch);

const status = document.getElementById('status');
const settings = document.getElementById('settings');

const worker = connectWorker(sidekickProtocol);

const view: ConnectView = await runConnectPage({
  href: location.href,
  replaceUrl: (url) => history.replaceState(null, '', url),
  tabId: async () => (await chrome.tabs.getCurrent())?.id,
  connect: (input) => worker.call('mcp.connect', input, { timeout: false }),
}).catch((error: unknown) => ({
  text: `Sidekick couldn’t connect: ${error instanceof Error ? error.message : String(error)}`,
  settings: false,
}));

if (status) status.textContent = view.text;

if (settings) settings.hidden = !view.settings;

if (view.close) {
  const tab = await chrome.tabs.getCurrent();

  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
}
