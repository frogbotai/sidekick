import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { describe, expect, it, vi } from 'vitest';

import background from './entrypoints/background';

function start() {
  installFakeChrome();

  const calls: string[] = [];
  let onInstalled: (details: { reason: string }) => void = () => {};

  const setAccessLevel = vi.spyOn(chrome.storage.local, 'setAccessLevel').mockImplementation(() => {
    calls.push('setAccessLevel');

    return Promise.resolve();
  });

  const query = vi.fn(() => Promise.resolve([{ id: 4 }]));
  const executeScript = vi.fn(() => Promise.resolve([]));

  Object.assign(chrome, {
    sidePanel: {
      setPanelBehavior: () => Promise.resolve(void calls.push('setPanelBehavior')),
    },
    runtime: {
      onConnect: { addListener: () => void calls.push('onConnect') },
      onInstalled: {
        addListener: (listener: typeof onInstalled) => {
          calls.push('onInstalled');
          onInstalled = listener;
        },
      },
    },
    tabs: { query },
    scripting: { executeScript },
  });

  background.main();

  return {
    calls,
    setAccessLevel,
    query,
    executeScript,
    install: (reason: string) => onInstalled({ reason }),
  };
}

describe('background', () => {
  it('restricts storage.local to trusted contexts before anything else on start', () => {
    const { calls, setAccessLevel } = start();

    expect(calls).toEqual(['setAccessLevel', 'setPanelBehavior', 'onConnect', 'onInstalled']);
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
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

  it('does not inject again when only Chrome updated, since the manifest script already runs', () => {
    const { install, query } = start();

    install('chrome_update');

    expect(query).not.toHaveBeenCalled();
  });
});
