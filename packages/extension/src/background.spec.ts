import { tools } from '@frogbotai/sidekick-core';
import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { describe, expect, it, vi } from 'vitest';

import background from './entrypoints/background';

function start() {
  installFakeChrome();

  const calls: string[] = [];
  let onInstalled: (details: { reason: string; previousVersion?: string }) => void = () => {};

  const setAccessLevel = vi.spyOn(chrome.storage.local, 'setAccessLevel').mockImplementation(() => {
    calls.push('setAccessLevel');

    return Promise.resolve();
  });

  const query = vi.fn(() => Promise.resolve([{ id: 4 }]));
  const executeScript = vi.fn(() => Promise.resolve([]));
  const event = () => ({ addListener: () => undefined, removeListener: () => undefined });

  Object.assign(chrome, {
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(void calls.push('setPanelBehavior')),
    },
    runtime: {
      id: 'sidekicktestid',
      getManifest: () => ({ version: '0.9.0' }),
      onConnect: { addListener: () => void calls.push('onConnect') },
      onMessage: { addListener: () => void calls.push('onMessage') },
      onMessageExternal: { addListener: () => void calls.push('onMessageExternal') },
      onInstalled: {
        addListener: (listener: typeof onInstalled) => {
          calls.push('onInstalled');
          onInstalled = listener;
        },
      },
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      getTargets: () => Promise.resolve([]),
      detach: () => Promise.resolve(),
    },
    tabs: { query },
    webNavigation: {
      onCreatedNavigationTarget: event(),
      onCommitted: event(),
      onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event(),
    },
    tabGroups: { onRemoved: event() },
    scripting: { executeScript },
  });

  background.main();

  return {
    calls,
    setAccessLevel,
    query,
    executeScript,
    install: (reason: string, previousVersion?: string) =>
      onInstalled({ reason, ...(previousVersion ? { previousVersion } : {}) }),
  };
}

describe('background', () => {
  it('restricts storage.local to trusted contexts before anything else on start', () => {
    const { calls, setAccessLevel } = start();

    expect(calls).toEqual([
      'setAccessLevel',
      'setPanelBehavior',
      'onConnect',
      'onMessage',
      'onMessageExternal',
      'onInstalled',
    ]);

    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('registers the 15 browser tools as built-ins', () => {
    start();

    expect(tools.list()).toHaveLength(15);
    expect(tools.errors()).toEqual([]);
  });

  it.each(['install', 'update'])(
    'injects the frame script into open tabs on %s',
    async (reason) => {
      const { install, executeScript } = start();

      install(reason);

      await vi.waitFor(() =>
        expect(executeScript).toHaveBeenCalledWith({
          target: { tabId: 4, allFrames: true },
          files: ['frame.js'],
        }),
      );
    },
  );

  it('clears 0.8.x storage on an update from 0.8.x', async () => {
    const { install } = start();

    await chrome.storage.local.set({ auth_user: { id: 'u' }, theme: 'dark' });
    install('update', '0.8.3');

    await vi.waitFor(async () =>
      expect(await chrome.storage.local.get(null)).toEqual({
        theme: 'dark',
        legacyPanelCleanup: true,
      }),
    );
  });

  it('does not inject again when only Chrome updated, since the manifest script already runs', () => {
    const { install, query } = start();

    install('chrome_update');

    expect(query).not.toHaveBeenCalled();
  });
});
