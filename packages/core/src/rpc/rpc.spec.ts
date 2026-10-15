import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { EXTENSION_ORIGIN, type FakeRuntime, installFakeRuntime } from '../testing/fakeRuntime';
import { CALL_TIMEOUT, connectWorker, HEARTBEAT, MAX_BACKOFF, MIN_BACKOFF } from './client';
import { CONNECTED, defineProtocol } from './define';
import { serve } from './server';
import { PORT_NAME, RpcError } from './wire';

const protocol = defineProtocol({
  methods: {
    echo: {
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string(), length: z.number() }),
    },
    boom: { input: z.object({}), output: z.object({}) },
    wait: { input: z.object({}), output: z.object({}) },
    lie: { input: z.object({}), output: z.object({ ok: z.literal(true) }) },
  },
  events: { 'session.updated': z.object({ id: z.string() }) },
});

let fake: FakeRuntime;
let release: () => void;

async function flush() {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

function start(bootId = 'boot-1') {
  return serve(
    protocol,
    {
      echo: ({ text }) => ({ text, length: text.length }),
      boom: () => {
        throw new Error('kaboom');
      },
      wait: () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
      lie: () => ({ ok: false as unknown as true }),
    },
    { bootId },
  );
}

async function rejection(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (!(error instanceof RpcError)) throw new Error(`Expected an RpcError, got ${String(error)}`);

  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = installFakeRuntime();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connectWorker and serve', () => {
  it('round-trips a call, validating both ends', async () => {
    start();

    const worker = connectWorker(protocol);

    await expect(worker.call('echo', { text: 'hi' })).resolves.toEqual({ text: 'hi', length: 2 });
    expect(fake.clientPorts[0]?.name).toBe(PORT_NAME);
  });

  it('sends worker.connected { bootId } first on every port', async () => {
    start('boot-a');

    const worker = connectWorker(protocol);
    const connected = vi.fn();

    worker.on(CONNECTED, connected);
    await flush();

    expect(fake.serverPorts[0]?.sent[0]).toMatchObject({
      kind: 'event',
      type: CONNECTED,
      data: { bootId: 'boot-a' },
    });

    expect(connected).toHaveBeenCalledWith({ bootId: 'boot-a' });
  });

  it('rejects bad input with invalid, and answers a request without an id with nothing', async () => {
    start();

    const worker = connectWorker(protocol);
    const error = await rejection(worker.call('echo', { text: 1 as unknown as string }));

    expect(error.code).toBe('invalid');

    const port = fake.clientPorts[0];
    const server = fake.serverPorts[0];

    if (!port || !server) throw new Error('No port');

    const before = server.sent.length;

    port.postMessage({ kind: 'request', method: 'echo', input: { text: 'x' } });
    port.postMessage({ kind: 'nonsense', id: '9' });
    await flush();

    expect(server.sent.slice(before)).toEqual([
      { kind: 'error', id: '9', error: { code: 'invalid', message: 'Not a valid request' } },
    ]);
  });

  it('rejects a method the worker does not serve with unknown-method', async () => {
    start();

    const worker = connectWorker(protocol);
    const port = fake.clientPorts[0];

    port?.postMessage({ kind: 'request', id: 'x', method: 'missing', input: {} });
    await flush();

    expect(fake.serverPorts[0]?.sent.at(-1)).toMatchObject({
      kind: 'error',
      id: 'x',
      error: { code: 'unknown-method' },
    });

    const error = await rejection(worker.call('missing' as 'echo', { text: '' }));

    expect(error.code).toBe('unknown-method');
  });

  it('maps a thrown handler error to failed', async () => {
    start();

    const error = await rejection(connectWorker(protocol).call('boom', {}));

    expect(error).toMatchObject({ code: 'failed', message: 'kaboom' });
  });

  it('rejects output that fails its schema with invalid', async () => {
    start();

    const error = await rejection(connectWorker(protocol).call('lie', {}));

    expect(error.code).toBe('invalid');
  });

  it('drops events with an unknown type or bad data, and delivers good ones', async () => {
    const server = start();
    const worker = connectWorker(protocol);
    const updated = vi.fn();

    worker.on('session.updated', updated);
    await flush();

    fake.serverPorts[0]?.postMessage({
      kind: 'event',
      id: 'e1',
      created: 1,
      type: 'session.updated',
      data: { id: 3 },
    });

    fake.serverPorts[0]?.postMessage({ kind: 'event', id: 'e2', created: 1, type: 'x', data: {} });
    server.emit('session.updated', { id: 's1' });
    await flush();

    expect(updated.mock.calls).toEqual([[{ id: 's1' }]]);
  });

  it('times out a call that gets no answer', async () => {
    start();

    const worker = connectWorker(protocol, { timeout: 1_000 });
    const call = rejection(worker.call('wait', {}));

    await vi.advanceTimersByTimeAsync(1_000);

    expect((await call).code).toBe('timeout');
    expect(CALL_TIMEOUT).toBe(30_000);
  });

  it('lets a call opt out of the timeout', async () => {
    start();

    const worker = connectWorker(protocol);
    let settled = false;

    const call = worker.call('wait', {}, { timeout: false }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT + 1_000);

    expect(settled).toBe(false);

    release();

    await expect(call).resolves.toEqual({});
  });

  it.each([
    ['a foreign extension', { id: 'other', url: `${EXTENSION_ORIGIN}sidepanel.html` }],
    ['a web page', { id: 'sidekicktestid', url: 'https://example.com/', tab: { id: 1 } }],
    ['a sender with no url', { id: 'sidekicktestid' }],
  ])('silently disconnects %s', async (_name, sender) => {
    start();
    fake.connectSender = sender as chrome.runtime.MessageSender;

    const worker = connectWorker(protocol);
    const call = rejection(worker.call('echo', { text: 'hi' }));

    await flush();

    expect(fake.serverPorts[0]?.sent).toEqual([]);
    expect((await call).code).toBe('disconnected');
  });

  it('disconnects a port with the wrong name', async () => {
    start();
    chrome.runtime.connect({ name: 'other' });
    await flush();

    expect(fake.serverPorts[0]?.sent).toEqual([]);
  });

  it('rejects pending calls with disconnected when the worker stops, then reconnects', async () => {
    start('boot-1');

    const worker = connectWorker(protocol);
    const boots: string[] = [];

    worker.on(CONNECTED, ({ bootId }) => boots.push(bootId));
    await flush();

    const pending = rejection(worker.call('wait', {}));

    await flush();
    fake.stopWorker();
    await flush();

    expect((await pending).code).toBe('disconnected');
    expect((await rejection(worker.call('echo', { text: 'x' }))).code).toBe('disconnected');

    start('boot-2');
    await vi.advanceTimersByTimeAsync(MIN_BACKOFF);

    expect(boots).toEqual(['boot-1', 'boot-2']);
    await expect(worker.call('echo', { text: 'back' })).resolves.toMatchObject({ text: 'back' });

    release();
  });

  it('backs off from 100 ms doubling to 2 s, and resets after worker.connected', async () => {
    start();
    connectWorker(protocol);
    await flush();
    fake.failConnects = true;
    fake.stopWorker();
    await flush();

    const times: number[] = [];
    let previous = fake.connects;

    for (let elapsed = 0; elapsed <= 8_000; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);

      if (fake.connects !== previous) times.push(elapsed + 50);

      previous = fake.connects;
    }

    expect(times.slice(0, 7)).toEqual([100, 300, 700, 1_500, 3_100, 5_100, 7_100]);
    expect(MAX_BACKOFF).toBe(2_000);

    start();
    fake.failConnects = false;
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);

    const connected = fake.connects;

    fake.stopWorker();
    start();
    await flush();
    await vi.advanceTimersByTimeAsync(MIN_BACKOFF);

    expect(fake.connects).toBe(connected + 1);
  });

  it('sends a heartbeat every 20 s while connected, and stops on close', async () => {
    start();

    const worker = connectWorker(protocol);
    const port = fake.clientPorts[0];

    await vi.advanceTimersByTimeAsync(HEARTBEAT * 2);

    expect(port?.sent).toEqual([{ kind: 'heartbeat' }, { kind: 'heartbeat' }]);
    expect(fake.serverPorts[0]?.sent).toHaveLength(1);

    worker.close();
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 2);

    expect(port?.sent).toHaveLength(2);
    expect(fake.connects).toBe(1);
  });

  it('refuses to define the reserved worker.connected event', () => {
    expect(() => defineProtocol({ methods: {}, events: { [CONNECTED]: z.object({}) } })).toThrow(
      'reserved',
    );
  });
});
