import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cache, Cached } from './cache.js';
import { CONNECT_TIMEOUT, createRelay, type Message, type RelaySocket } from './relay.js';
import { OLD_EXTENSION } from './status.js';

function memoryCache(initial: Cached = {}): Cache {
  let data = { ...initial };

  return {
    read: () => Promise.resolve({ ...data }),
    write: (change) => {
      data = { ...data, ...change };

      return Promise.resolve();
    },
  };
}

function setup(hasToken: boolean, wake = vi.fn(() => Promise.resolve())) {
  const toClient: Message[] = [];
  const relay = createRelay({
    cache: memoryCache(),
    send: (message) => void toClient.push(message),
    wake,
    hasToken,
    helperVersion: '0.1.0',
  });

  return { relay, toClient, wake };
}

async function flush() {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

const initialize: Message = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'a', version: '1' },
  },
};

const list: Message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function namesOf(message: Message | undefined) {
  return (message?.result as { tools?: { name: string }[] } | undefined)?.tools?.map(
    ({ name }) => name,
  );
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('status while Sidekick can’t connect', () => {
  it('answers initialize and lists status and settings with no token and no cache', async () => {
    const { relay, toClient, wake } = setup(false);

    relay.fromClient(initialize);
    relay.fromClient(list);
    await flush();

    expect(toClient[0]?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'sidekick', version: '0.1.0' },
    });

    expect(namesOf(toClient[1])).toEqual(['settings', 'status']);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('lists status when Chrome can’t be opened, then reports the change once Sidekick connects', async () => {
    const { relay, toClient } = setup(
      true,
      vi.fn(() => Promise.reject(new Error('ENOENT'))),
    );

    relay.fromClient(initialize);
    relay.fromClient(list);
    await flush();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT);

    expect(namesOf(toClient[1])).toContain('status');

    const listeners: Record<string, (data?: unknown) => void> = {};
    const sent: Message[] = [];
    const socket: RelaySocket = {
      send: (data) => void sent.push(JSON.parse(data) as Message),
      close: () => listeners.close?.(),
      on: (event: string, listener: (data?: unknown) => void) => void (listeners[event] = listener),
    };

    relay.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snapshot' } });
    await flush();
    relay.attach(socket);

    const init = sent.find((message) => message.method === 'initialize');

    listeners.message?.(JSON.stringify({ jsonrpc: '2.0', id: init?.id, result: {} }));

    const refresh = sent.find((message) => message.method === 'tools/list');

    listeners.message?.(
      JSON.stringify({
        jsonrpc: '2.0',
        id: refresh?.id,
        result: { tools: [{ name: 'snapshot' }] },
      }),
    );

    await flush();

    expect(toClient).toContainEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  });
});

describe('status against an extension without the status tool', () => {
  it('reports the helper version, a mismatch and the restart step', () => {
    const { relay, toClient } = setup(true);
    const listeners: Record<string, (data?: unknown) => void> = {};

    relay.attach({
      send: () => undefined,
      close: () => listeners.close?.(),
      on: (event: string, listener: (data?: unknown) => void) => void (listeners[event] = listener),
    });

    relay.fromClient({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'status' } });

    listeners.message?.(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        result: { isError: true, content: [{ type: 'text', text: 'No worker tool named status' }] },
      }),
    );

    const result = toClient.at(-1)?.result as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBeUndefined();

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      connected: true,
      pairingState: 'paired',
      helperVersion: '0.1.0',
      versionMismatch: true,
      nextStep: OLD_EXTENSION,
    });
  });
});
