import {
  computerName,
  isLoopbackHub,
  type McpConnectResult,
  type McpPairResult,
  type McpUnpairResult,
} from '@frogbotai/sidekick-core';

/** What the connect page shows: a line of text, and whether it points to settings. */
export interface ConnectView {
  text: string;
  settings: boolean;
  /** Close the tab: Sidekick was already connected to this helper and works in another tab. */
  close?: boolean;
  /** A second line under the text. */
  detail?: string;
  /** An Approve button, and what the page shows once it's clicked. */
  approve?: () => Promise<ConnectView>;
}

export interface ConnectPage {
  href: string;
  /** Replaces the address bar's URL, to drop the token from it and the tab's history. */
  replaceUrl: (url: string) => void;
  tabId: () => Promise<number | undefined>;
  connect: (input: { hub: string; token: string; tabId?: number }) => Promise<McpConnectResult>;
  /** Tells the install command's hub that its Approve page loaded, so it doesn't wait in vain. */
  shown: (input: { hub: string; pair: string }) => void;
  pair: (input: { hub: string; pair: string; computer: string }) => Promise<McpPairResult>;
  unpair: (input: { hub: string; token: string }) => Promise<McpUnpairResult>;
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

const RETRY = 'Run the install command again, then approve.';

function shown(text: string | null) {
  return text?.trim() ? computerName(text) : '';
}

function pairView(page: ConnectPage, hub: string, pair: string, url: URL): ConnectView {
  const computer = shown(url.searchParams.get('computer'));
  const agents = shown(url.searchParams.get('agents')) || 'your agents';
  const on = computer ? ` on ${computer}` : '';

  return {
    text: `Add Sidekick to ${agents}${on}?`,
    detail:
      'A command on this computer asked for this. Approve only if you ran it: the agents can then use Sidekick’s browser tools.',
    settings: false,
    approve: async () => {
      const result = await page.pair({ hub, pair, computer });

      if (result.paired) {
        return {
          text: `Sidekick is added to ${agents}${on}. You can close this tab.`,
          settings: false,
        };
      }

      return {
        text: `This request expired, was already used, or its command stopped. ${RETRY}`,
        settings: false,
      };
    },
  };
}

async function unpairView(page: ConnectPage, hub: string, token: string): Promise<ConnectView> {
  const result = await page.unpair({ hub, token });

  if (result.unpaired) {
    return { text: 'Sidekick is removed from this computer.', settings: false, close: true };
  }

  return {
    text: 'Sidekick couldn’t reach the uninstall command. Revoke this computer in Connected agents.',
    settings: true,
  };
}

/**
 * The connect page a helper opens: it drops the token and pairing request from the URL at once,
 * refuses a hub that isn't on this computer or a missing token without asking anything, and
 * hands the rest to the worker. An install command's pairing request waits for Approve; an
 * uninstall's revoke needs no click, because only the key's holder can ask for it.
 */
export async function runConnectPage(page: ConnectPage): Promise<ConnectView> {
  const url = new URL(page.href);
  const hub = url.searchParams.get('hub') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const pair = url.searchParams.get('pair') ?? '';
  const unpair = url.searchParams.get('unpair') === '1';

  for (const name of ['token', 'pair', 'unpair']) url.searchParams.delete(name);

  page.replaceUrl(url.href);

  if (!isLoopbackHub(hub)) return { text: SETTINGS, settings: true };

  if (pair) {
    page.shown({ hub, pair });

    return pairView(page, hub, pair, url);
  }

  if (!token) return { text: SETTINGS, settings: true };

  if (unpair) return unpairView(page, hub, token);

  const tabId = await page.tabId();

  return viewOf(await page.connect({ hub, token, ...(tabId === undefined ? {} : { tabId }) }));
}
