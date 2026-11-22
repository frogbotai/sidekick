import { describe, expect, it, vi } from 'vitest';

import { type ConnectPage, runConnectPage } from './connect';

const BASE = 'chrome-extension://kilnglameccalibejghopglodbidhkmj/connect.html';

function page(
  query: string,
  connect: ConnectPage['connect'] = vi.fn(),
  calls: Partial<Pick<ConnectPage, 'pair' | 'unpair'>> = {},
) {
  const replaced: string[] = [];
  const pair = calls.pair ?? vi.fn<ConnectPage['pair']>();
  const unpair = calls.unpair ?? vi.fn<ConnectPage['unpair']>();
  const shown = vi.fn<ConnectPage['shown']>();

  return {
    replaced,
    connect,
    shown,
    pair,
    unpair,
    page: {
      href: `${BASE}?${query}`,
      replaceUrl: (url: string) => void replaced.push(url),
      tabId: () => Promise.resolve(7),
      connect,
      shown,
      pair,
      unpair,
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

  it('asks before pairing an install command, names its computer and agents, and pairs on Approve', async () => {
    const pair = vi.fn<ConnectPage['pair']>(() =>
      Promise.resolve({ paired: true, name: 'laptop' }),
    );

    const target = page(
      `hub=${HUB}&pair=req-1&computer=laptop&agents=${encodeURIComponent('Codex, Cursor')}`,
      vi.fn(),
      { pair },
    );

    const view = await runConnectPage(target.page);

    expect(target.replaced).toEqual([`${BASE}?hub=${HUB}&computer=laptop&agents=Codex%2C+Cursor`]);

    expect(view.text).toBe('Add Sidekick to Codex, Cursor on laptop?');
    expect(view.detail).toContain('Approve only if you ran it');
    expect(target.shown).toHaveBeenCalledWith({ hub: 'ws://127.0.0.1:4100/secret', pair: 'req-1' });
    expect(pair).not.toHaveBeenCalled();
    expect(target.connect).not.toHaveBeenCalled();

    const done = await view.approve?.();

    expect(pair).toHaveBeenCalledWith({
      hub: 'ws://127.0.0.1:4100/secret',
      pair: 'req-1',
      computer: 'laptop',
    });

    expect(done?.text).toBe(
      'Sidekick is added to Codex, Cursor on laptop. You can close this tab.',
    );
  });

  it('says a used or expired request can’t pair, and never asks for a hub off this computer', async () => {
    const refused = await runConnectPage(
      page(`hub=${HUB}&pair=old&computer=laptop`, vi.fn(), {
        pair: () => Promise.resolve({ paired: false, reason: 'unreachable' }),
      }).page,
    );

    expect((await refused.approve?.())?.text).toContain('expired, was already used');

    const off = await runConnectPage(
      page(`hub=${encodeURIComponent('ws://example.com/x')}&pair=req&computer=laptop`).page,
    );

    expect(off.approve).toBeUndefined();
    expect(off.settings).toBe(true);
  });

  it('revokes for uninstall without a click, then closes the tab', async () => {
    const unpair = vi.fn<ConnectPage['unpair']>(() => Promise.resolve({ unpaired: true }));
    const target = page(`hub=${HUB}&token=sk_a&unpair=1`, vi.fn(), { unpair });
    const view = await runConnectPage(target.page);

    expect(target.replaced).toEqual([`${BASE}?hub=${HUB}`]);
    expect(unpair).toHaveBeenCalledWith({ hub: 'ws://127.0.0.1:4100/secret', token: 'sk_a' });
    expect(target.connect).not.toHaveBeenCalled();
    expect(view.close).toBe(true);
  });
});
