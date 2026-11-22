import { afterEach, describe, expect, it, vi } from 'vitest';

import { chromeEncoder, DOWNLOAD_TIMEOUT_MS } from './encoder';

type Listener = (message: unknown) => void;

const FILE = 'sidekick-recording-2026-11-18-03-00-00.mp4';

function installChrome(item: { state: string; filename: string; error?: string }) {
  const requests: Record<string, unknown>[] = [];
  const cancelled: number[] = [];

  const connect = () => {
    const listeners: Listener[] = [];

    return {
      onMessage: { addListener: (listener: Listener) => void listeners.push(listener) },
      onDisconnect: { addListener: () => undefined },
      disconnect: () => undefined,
      postMessage: (message: Record<string, unknown>) => {
        requests.push(message);

        const ok =
          message.type === 'close'
            ? { url: 'blob:chrome-extension://x/1', codec: 'avc', bytes: 10, width: 2, height: 2 }
            : null;

        queueMicrotask(() => {
          for (const listener of listeners) listener({ id: message.id, ok });
        });
      },
    };
  };

  vi.stubGlobal('chrome', {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: () => Promise.resolve([{}]),
      getURL: (path: string) => `chrome-extension://x/${path}`,
      connect,
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      createDocument: () => Promise.resolve(),
      closeDocument: () => Promise.resolve(),
    },
    downloads: {
      download: () => Promise.resolve(7),
      search: () => Promise.resolve([{ id: 7, ...item }]),
      cancel: (id: number) => {
        cancelled.push(id);

        return Promise.resolve();
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
  });

  return { requests, cancelled };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chromeEncoder downloads (sidekick-19)', () => {
  it('fails close with Chrome’s reason when the download is interrupted', async () => {
    installChrome({ state: 'interrupted', error: 'FILE_NO_SPACE', filename: '' });

    const encoder = chromeEncoder();

    await encoder.open('r1', { frameRate: 10 });

    await expect(encoder.close('r1', FILE)).rejects.toThrow('FILE_NO_SPACE');
  });

  it('reports the file name Chrome saved after it renamed a clash', async () => {
    installChrome({
      state: 'complete',
      filename: '/home/person/Downloads/sidekick-recording-2026-11-18-03-00-00 (1).mp4',
    });

    const encoder = chromeEncoder();

    await encoder.open('r1', { frameRate: 10 });

    expect((await encoder.close('r1', FILE)).file).toBe(
      'sidekick-recording-2026-11-18-03-00-00 (1).mp4',
    );
  });

  it('reports a Windows path’s file name', async () => {
    installChrome({ state: 'complete', filename: 'C:\\Users\\person\\Downloads\\video (2).mp4' });

    const encoder = chromeEncoder();

    await encoder.open('r1', { frameRate: 10 });

    expect((await encoder.close('r1', FILE)).file).toBe('video (2).mp4');
  });

  it('fails close and cancels the download when it is still running at the timeout', async () => {
    vi.useFakeTimers();

    const chrome = installChrome({ state: 'in_progress', filename: '' });
    const encoder = chromeEncoder();

    await encoder.open('r1', { frameRate: 10 });

    const settled = encoder.close('r1', FILE).then(
      (saved) => ({ saved }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);

    expect(await settled).toHaveProperty('error');
    expect(chrome.cancelled).toEqual([7]);
  });
});
