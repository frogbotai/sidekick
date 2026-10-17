import { describe, expect, it, vi } from 'vitest';

import { type ConnectPage, runConnectPage } from './connect';

const BASE = 'chrome-extension://kilnglameccalibejghopglodbidhkmj/connect.html';

function page(query: string, connect: ConnectPage['connect'] = vi.fn()) {
  const replaced: string[] = [];

  return {
    replaced,
    connect,
    page: {
      href: `${BASE}?${query}`,
      replaceUrl: (url: string) => void replaced.push(url),
      tabId: () => Promise.resolve(7),
      connect,
    } satisfies ConnectPage,
  };
}

const HUB = encodeURIComponent('ws://127.0.0.1:4100/secret');

describe('the connect page', () => {
  it('refuses a hub off this computer, or no token, without asking or dialing', async () => {
    for (const query of [
      `hub=${encodeURIComponent('ws://example.com/x')}&token=sk_a`,
      `hub=${HUB}`,
      'token=sk_a',
    ]) {
      const { page: target, connect, replaced } = page(query);
      const view = await runConnectPage(target);

      expect(view.settings).toBe(true);
      expect(connect).not.toHaveBeenCalled();
      expect(replaced.every((url) => !url.includes('token'))).toBe(true);
    }
  });

  it('strips the token before connecting, and hands the hub, token and tab to the worker', async () => {
    const connect = vi.fn<ConnectPage['connect']>(() =>
      Promise.resolve({ connected: true, name: 'OpenCode', adopted: true }),
    );

    const { page: target, replaced } = page(`hub=${HUB}&token=sk_a`, connect);
    const view = await runConnectPage(target);

    expect(replaced).toEqual([`${BASE}?hub=${HUB}`]);

    expect(connect).toHaveBeenCalledWith({
      hub: 'ws://127.0.0.1:4100/secret',
      token: 'sk_a',
      tabId: 7,
    });

    expect(view).toEqual({
      text: 'Connected to OpenCode, which works in this tab group.',
      settings: false,
    });
  });

  it('points to settings for an unknown token, and closes a tab Sidekick didn’t need', async () => {
    const unknown = await runConnectPage(
      page(`hub=${HUB}&token=sk_old`, () =>
        Promise.resolve({ connected: false, reason: 'unknown_token' }),
      ).page,
    );

    expect(unknown.settings).toBe(true);
    expect(unknown.text).toContain('New command');

    const spare = await runConnectPage(
      page(`hub=${HUB}&token=sk_a`, () =>
        Promise.resolve({ connected: true, name: 'Codex', adopted: false }),
      ).page,
    );

    expect(spare.close).toBe(true);
  });
});
