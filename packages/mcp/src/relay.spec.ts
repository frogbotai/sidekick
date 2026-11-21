import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cache, Cached } from './cache.js';
import {
  CONNECT_TIMEOUT,
  createRelay,
  type Message,
  NO_CHROME,
  NO_CONNECTION,
  NO_TOKEN,
  NOT_CONNECTED,
  NOT_WOKEN,
  type RelaySocket,
} from './relay.js';
import { OLD_EXTENSION } from './status.js';

const INIT_RESULT = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'sidekick', version: '0.9.0' },
};

const TOOLS = { tools: [{ name: 'snapshot', inputSchema: { type: 'object' } }] };

function memoryCache(initial: Cached = {}): Cache & { data: Cached } {
  const cache = {
    data: { ...initial },
    read: () => Promise.resolve({ ...cache.data }),
    write: (change: Partial<Cached>) => {
      cache.data = { ...cache.data, ...change };

      return Promise.resolve();
    },
  };

  return cache;
}

function workerSocket() {
  const events = new EventEmitter();
  const sent: Message[] = [];

  const socket: RelaySocket & {
    sent: Message[];
    reply: (message: Message) => void;
    drop: () => void;
  } = {
    sent,
    send: (data) => void sent.push(JSON.parse(data) as Message),
    close: () => void events.emit('close'),
    on: (event: string, listener: (data?: unknown) => void) => events.on(event, listener),
    reply: (message) => void events.emit('message', JSON.stringify(message)),
    drop: () => void events.emit('close'),
  };

  return socket;
}

function setup({
  cache = memoryCache(),
  hasToken = true,
  wake = vi.fn(() => Promise.resolve()),
} = {}) {
  const toClient: Message[] = [];
  const relay = createRelay({
    cache,
    send: (message) => void toClient.push(message),
    wake,
    hasToken,
    helperVersion: '0.1.0',
  });

  return { relay, toClient, wake, cache };
}

const initialize: Message = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'opencode', version: '2' },
  },
};

async function flush() {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

function answerHandshake(socket: ReturnType<typeof workerSocket>) {
  const init = socket.sent.find((message) => message.method === 'initialize');

  socket.reply({ jsonrpc: '2.0', id: init?.id, result: INIT_RESULT });
}

const call = (id: number, name: string): Message => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the relay', () => {
  it('wakes Sidekick once for the first request, forwards it when the socket comes, and caches the answers', async () => {
    const { relay, toClient, wake, cache } = setup();

    relay.fromClient(initialize);
    relay.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);

    const socket = workerSocket();

    relay.attach(socket);

    expect(socket.sent.map((message) => message.method)).toEqual(['initialize', 'tools/list']);

    socket.reply({ jsonrpc: '2.0', id: 0, result: INIT_RESULT });
    socket.reply({ jsonrpc: '2.0', id: 1, result: TOOLS });
    await flush();

    expect(toClient).toEqual([
      { jsonrpc: '2.0', id: 0, result: INIT_RESULT },
      { jsonrpc: '2.0', id: 1, result: TOOLS },
    ]);

    expect(cache.data).toEqual({
      protocolVersion: '2025-11-25',
      initialize: INIT_RESULT,
      tools: TOOLS,
    });
  });

  it('answers initialize, tools/list and ping from the cache with no wake', async () => {
    const cache = memoryCache({
      protocolVersion: '2025-11-25',
      initialize: INIT_RESULT,
      tools: TOOLS,
    });

    const { relay, toClient, wake } = setup({ cache });

    relay.fromClient({ ...initialize, id: 7 });
    relay.fromClient({ jsonrpc: '2.0', method: 'notifications/initialized' });
    relay.fromClient({ jsonrpc: '2.0', id: 8, method: 'tools/list' });
    relay.fromClient({ jsonrpc: '2.0', id: 9, method: 'ping' });
    await flush();

    expect(wake).not.toHaveBeenCalled();

    expect(toClient).toEqual([
      { jsonrpc: '2.0', id: 7, result: INIT_RESULT },
      { jsonrpc: '2.0', id: 8, result: TOOLS },
      { jsonrpc: '2.0', id: 9, result: {} },
    ]);
  });

  it('asks Sidekick when the client wants another protocol version than the cached one', async () => {
    const cache = memoryCache({ protocolVersion: '2025-06-18', initialize: INIT_RESULT });
    const { relay, wake } = setup({ cache });

    relay.fromClient(initialize);
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('replays the client’s initialize on a new socket before its first call, and reports changed tools', async () => {
    const cache = memoryCache({
      protocolVersion: '2025-11-25',
      initialize: INIT_RESULT,
      tools: { tools: [] },
    });

    const { relay, toClient, wake } = setup({ cache });

    relay.fromClient(initialize);
    relay.fromClient({ jsonrpc: '2.0', method: 'notifications/initialized' });
    relay.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    relay.fromClient({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snapshot' } });
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);

    const socket = workerSocket();

    relay.attach(socket);

    expect(socket.sent).toEqual([
      expect.objectContaining({ method: 'initialize', params: initialize.params }),
    ]);

    answerHandshake(socket);

    expect(socket.sent.map((message) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);

    const list = socket.sent[2];

    socket.reply({ jsonrpc: '2.0', id: list?.id, result: TOOLS });
    await flush();

    expect(toClient).toContainEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect(cache.data.tools).toEqual(TOOLS);
    expect(toClient.filter((message) => message.id === list?.id)).toEqual([]);
  });

  it('answers calls a dropped socket cut off with the retry error, then wakes again', async () => {
    const { relay, toClient, wake } = setup();

    relay.fromClient(initialize);
    await flush();

    const socket = workerSocket();

    relay.attach(socket);
    socket.reply({ jsonrpc: '2.0', id: 0, result: INIT_RESULT });
    relay.fromClient({ jsonrpc: '2.0', method: 'notifications/initialized' });
    relay.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait' } });
    relay.fromClient({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    await flush();

    socket.drop();

    expect(toClient.slice(1)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: { isError: true, content: [{ type: 'text', text: NOT_CONNECTED }] },
      },
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: NOT_CONNECTED } },
    ]);

    relay.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'snapshot' } });
    await flush();

    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('forwards Sidekick’s pings and progress to the client, and the client’s answers back', async () => {
    const { relay, toClient } = setup();

    relay.fromClient(initialize);
    await flush();

    const socket = workerSocket();

    relay.attach(socket);
    socket.reply({ jsonrpc: '2.0', id: 0, result: INIT_RESULT });
    socket.reply({ jsonrpc: '2.0', id: 0, method: 'ping' });
    relay.fromClient({ jsonrpc: '2.0', id: 0, result: {} });

    expect(toClient).toContainEqual({ jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(socket.sent).toContainEqual({ jsonrpc: '2.0', id: 0, result: {} });
  });

  it('fails a request that waits too long for Sidekick, and wakes again next time', async () => {
    const { relay, toClient, wake } = setup();

    relay.fromClient({ jsonrpc: '2.0', id: 0, method: 'resources/list' });
    await flush();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT);

    expect(toClient).toEqual([
      { jsonrpc: '2.0', id: 0, error: { code: -32000, message: NO_CONNECTION } },
    ]);

    relay.fromClient({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    await flush();

    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('fails a browser call at once without a token, opening the settings page only once', async () => {
    const { relay, toClient, wake } = setup({ hasToken: false });

    relay.fromClient(call(1, 'snapshot'));
    relay.fromClient(call(2, 'snapshot'));
    await flush();

    expect(wake).toHaveBeenCalledTimes(1);

    expect(toClient.map((message) => message.result)).toEqual([
      { isError: true, content: [{ type: 'text', text: NO_TOKEN }] },
      { isError: true, content: [{ type: 'text', text: NO_TOKEN }] },
    ]);
  });

  it('keeps the newest socket, failing calls on the one it replaces', async () => {
    const { relay, toClient } = setup();

    relay.fromClient(initialize);
    await flush();

    const first = workerSocket();

    relay.attach(first);
    first.reply({ jsonrpc: '2.0', id: 0, result: INIT_RESULT });
    relay.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait' } });

    const second = workerSocket();

    relay.attach(second);
    first.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } });

    expect(toClient.at(-1)).toMatchObject({ id: 1, result: { isError: true } });
    expect(second.sent[0]).toMatchObject({ method: 'initialize' });
  });
});

function textOf(message: Message | undefined) {
  const result = message?.result as { isError?: boolean; content: { text: string }[] };

  return { isError: result.isError ?? false, value: JSON.parse(result.content[0]?.text ?? '') };
}

function statusOf(toClient: Message[], id: number) {
  return textOf(toClient.find((message) => message.id === id)).value as Record<string, unknown>;
}

describe('status and settings while disconnected', () => {
  it('answers status without a token at once, with no wake', async () => {
    const { relay, toClient, wake } = setup({ hasToken: false });

    relay.fromClient(call(1, 'status'));
    await flush();

    expect(wake).not.toHaveBeenCalled();

    expect(statusOf(toClient, 1)).toEqual({
      connected: false,
      pairingState: 'no_token',
      nextStep: NO_TOKEN,
      helperVersion: '0.1.0',
      versionMismatch: false,
    });
  });

  it('says a browser call connects Sidekick before any wake', async () => {
    const { relay, toClient, wake } = setup();

    relay.fromClient(call(1, 'status'));
    await flush();

    expect(wake).not.toHaveBeenCalled();
    expect(statusOf(toClient, 1)).toMatchObject({ pairingState: 'token_set', nextStep: NOT_WOKEN });
  });

  it('gives the next step for a failed wake, a timed-out wake and a dropped socket', async () => {
    const failing = setup({ wake: vi.fn(() => Promise.reject(new Error('no chrome'))) });

    failing.relay.fromClient(call(1, 'snapshot'));
    await flush();
    failing.relay.fromClient(call(2, 'status'));
    await flush();

    expect(statusOf(failing.toClient, 2).nextStep).toBe(NO_CHROME);

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT);
    failing.relay.fromClient(call(3, 'status'));
    await flush();

    expect(statusOf(failing.toClient, 3).nextStep).toBe(NO_CHROME);

    const silent = setup();

    silent.relay.fromClient(call(1, 'snapshot'));
    await flush();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT);
    silent.relay.fromClient(call(2, 'status'));
    await flush();

    expect(statusOf(silent.toClient, 2).nextStep).toBe(NO_CONNECTION);

    const dropped = setup();
    const socket = workerSocket();

    dropped.relay.attach(socket);
    socket.drop();
    dropped.relay.fromClient(call(1, 'status'));
    await flush();

    expect(statusOf(dropped.toClient, 1).nextStep).toBe(NOT_CONNECTED);
    expect(dropped.wake).not.toHaveBeenCalled();
  });

  it('fails settings at once with the same next step', async () => {
    const { relay, toClient, wake } = setup({ hasToken: false });

    relay.fromClient(call(1, 'settings'));
    await flush();

    expect(wake).not.toHaveBeenCalled();

    expect(toClient).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ nextStep: NO_TOKEN }) }],
        },
      },
    ]);
  });

  it('answers a status queued on a socket that closes before it is ready, without a wake', async () => {
    const { relay, toClient, wake } = setup({
      cache: memoryCache({ protocolVersion: '2025-11-25', initialize: INIT_RESULT }),
    });

    relay.fromClient(initialize);
    await flush();

    const socket = workerSocket();

    relay.attach(socket);
    relay.fromClient(call(5, 'status'));
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);

    expect(wake).not.toHaveBeenCalled();
    expect(statusOf(toClient, 5)).toMatchObject({ connected: false, nextStep: NOT_CONNECTED });
  });

  it('gives queued browser calls the same open-Chrome wording status gives for a failed wake', async () => {
    const { relay, toClient } = setup({ wake: vi.fn(() => Promise.reject(new Error('ENOENT'))) });

    relay.fromClient(call(1, 'snapshot'));
    await flush();
    relay.fromClient(call(2, 'status'));
    await flush();

    expect(statusOf(toClient, 2).nextStep).toBe(NO_CHROME);

    const snapshot = toClient.find((message) => message.id === 1)?.result as {
      content: { text: string }[];
    };

    expect(snapshot.content[0]?.text).toBe(NO_CHROME);
  });

  it('doesn’t report a failed wake while a newer wake is still in progress', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const wake = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementation(() => new Promise(() => undefined));

    const { relay, toClient } = setup({ wake });

    relay.fromClient(call(1, 'snapshot'));
    await flush();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT);
    relay.fromClient(call(2, 'snapshot'));
    await flush();
    rejectFirst(new Error('late'));
    await flush();
    relay.fromClient(call(3, 'status'));

    expect(statusOf(toClient, 3).nextStep).toBe(NO_CONNECTION);
  });

  it('forwards status and settings to a live socket, adding the versions to status', () => {
    const { relay, toClient } = setup();
    const socket = workerSocket();

    relay.attach(socket);
    relay.fromClient(call(1, 'status'));
    relay.fromClient(call(2, 'settings'));
    relay.fromClient(call(3, 'status'));

    expect(socket.sent.map((message) => message.id)).toEqual([1, 2, 3]);

    const status = (extensionVersion: string) => ({
      content: [{ type: 'text', text: JSON.stringify({ connected: true, extensionVersion }) }],
    });

    socket.reply({ jsonrpc: '2.0', id: 1, result: status('0.9.0') });
    socket.reply({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } });
    socket.reply({ jsonrpc: '2.0', id: 3, result: status('0.8.2') });

    expect(statusOf(toClient, 1)).toEqual({
      connected: true,
      extensionVersion: '0.9.0',
      helperVersion: '0.1.0',
      versionMismatch: false,
    });

    expect(statusOf(toClient, 2)).toEqual({});
    expect(statusOf(toClient, 3)).toMatchObject({ versionMismatch: true, nextStep: OLD_EXTENSION });
  });
});
