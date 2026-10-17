import { isLoopbackHub, type McpConnectResult } from '@frogbotai/sidekick-core';

/** What the connect page shows: a line of text, and whether it points to settings. */
export interface ConnectView {
  text: string;
  settings: boolean;
  /** Close the tab: Sidekick was already connected to this helper and works in another tab. */
  close?: boolean;
}

export interface ConnectPage {
  href: string;
  /** Replaces the address bar's URL, to drop the token from it and the tab's history. */
  replaceUrl: (url: string) => void;
  tabId: () => Promise<number | undefined>;
  connect: (input: { hub: string; token: string; tabId?: number }) => Promise<McpConnectResult>;
}

const SETTINGS =
  'To connect an agent app, add it in Sidekick’s settings under Connected agents and run the command shown there.';

function viewOf(result: McpConnectResult): ConnectView {
  if (result.connected) {
    return {
      text: `Connected to ${result.name}, which works in this tab group.`,
      settings: false,
      ...(result.adopted ? {} : { close: true }),
    };
  }

  if (result.reason === 'unknown_token') {
    return {
      text: 'This agent’s token isn’t paired with Sidekick. In Connected agents, use New command and run it again.',
      settings: true,
    };
  }

  if (result.reason === 'not_loopback') return { text: SETTINGS, settings: true };

  return {
    text: 'Sidekick couldn’t reach the agent app. Run it again, then retry.',
    settings: false,
  };
}

/**
 * The connect page a helper opens: it drops the token from the URL at once, refuses a hub that
 * isn't on this computer or a missing token without asking anything, and hands the rest to the
 * worker, which checks the token and dials.
 */
export async function runConnectPage(page: ConnectPage): Promise<ConnectView> {
  const url = new URL(page.href);
  const hub = url.searchParams.get('hub') ?? '';
  const token = url.searchParams.get('token') ?? '';

  url.searchParams.delete('token');
  page.replaceUrl(url.href);

  if (!isLoopbackHub(hub) || !token) return { text: SETTINGS, settings: true };

  const tabId = await page.tabId();

  return viewOf(await page.connect({ hub, token, ...(tabId === undefined ? {} : { tabId }) }));
}
