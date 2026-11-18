import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type Hub, refusal, startHub, startPairHub, STORE_EXTENSION_ID } from './hub.js';

const TOKEN = 'sk_test-token';

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
});

async function hub(extensionId = STORE_EXTENSION_ID) {
  const accepted: WebSocket[] = [];
  const started = await startHub({
    token: TOKEN,
    extensionId,
    onSocket: (socket) => accepted.push(socket),
  });

  hubs.push(started);

  return { ...started, accepted };
}

function dial(url: string, origin: string) {
  return new Promise<'open' | number>((resolve) => {
    const socket = new WebSocket(url, { origin });

    socket.once('open', () => {
      socket.close();
      resolve('open');
    });

    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.once('error', () => resolve(0));
  });
}

const withToken = (url: string, token = TOKEN) => `${url}?token=${encodeURIComponent(token)}`;

describe('the hub', () => {
  it('listens on 127.0.0.1 behind a random path', async () => {
    const one = await hub();
    const two = await hub();

    expect(one.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{24}$/);
    expect(new URL(one.url).pathname).not.toBe(new URL(two.url).pathname);
  });

  it('accepts Sidekick’s origin with the path and the token', async () => {
    const started = await hub();

    expect(await dial(withToken(started.url), `chrome-extension://${STORE_EXTENSION_ID}`)).toBe(
      'open',
    );

    expect(started.accepted).toHaveLength(1);
  });

  it('refuses a wrong origin, path or token with a 403', async () => {
    const started = await hub();
    const origin = `chrome-extension://${STORE_EXTENSION_ID}`;
    const { port } = new URL(started.url);

    expect(await dial(withToken(started.url), 'https://example.com')).toBe(403);
    expect(await dial(withToken(started.url), 'chrome-extension://otherextensionid')).toBe(403);
    expect(await dial(withToken(`ws://127.0.0.1:${port}/guess`), origin)).toBe(403);
    expect(await dial(withToken(started.url, 'sk_wrong'), origin)).toBe(403);
    expect(await dial(started.url, origin)).toBe(403);
    expect(started.accepted).toEqual([]);
  });

  it('takes SIDEKICK_EXTENSION_ID’s origin instead of the store’s', async () => {
    const started = await hub('devbuildextensionid');

    expect(await dial(withToken(started.url), 'chrome-extension://devbuildextensionid')).toBe(
      'open',
    );

    expect(await dial(withToken(started.url), `chrome-extension://${STORE_EXTENSION_ID}`)).toBe(
      403,
    );
  });

  it('refuses every socket when no token is set', () => {
    const request = {
      url: '/p?token=',
      headers: { origin: `chrome-extension://${STORE_EXTENSION_ID}` },
    };

    expect(
      refusal(request, { path: '/p', token: undefined, extensionId: STORE_EXTENSION_ID }),
    ).toBe('token');
  });
});

const ORIGIN = `chrome-extension://${STORE_EXTENSION_ID}`;

async function pairHub(ttl?: number) {
  const started = await startPairHub({ extensionId: STORE_EXTENSION_ID, ...(ttl ? { ttl } : {}) });

  hubs.push(started);

  return started;
}

function send(url: string, message: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(url, { origin: ORIGIN });

    socket.once('open', () => socket.send(JSON.stringify(message)));
    socket.once('message', (data) => resolve(JSON.parse(String(data))));
    socket.once('close', () => resolve(undefined));
    socket.once('error', reject);
  });
}

const withPair = (url: string, id: string) => `${url}?pair=${encodeURIComponent(id)}`;

describe('the hub in pair mode', () => {
  const KEY = { type: 'sidekick/paired', key: 'sk_new', pairingID: 'p1' };

  it('takes the key once, acknowledges it, and refuses every later socket', async () => {
    const started = await pairHub();

    expect(await send(withPair(started.url, started.id), KEY)).toEqual({ type: 'sidekick/ok' });
    expect(await started.paired).toEqual({ key: 'sk_new', pairingID: 'p1' });
    expect(await dial(withPair(started.url, started.id), ORIGIN)).toBe(403);
  });

  it('refuses a wrong origin, path or request id', async () => {
    const started = await pairHub();
    const { port } = new URL(started.url);

    expect(await dial(withPair(started.url, started.id), 'https://example.com')).toBe(403);
    expect(await dial(withPair(`ws://127.0.0.1:${port}/guess`, started.id), ORIGIN)).toBe(403);
    expect(await dial(withPair(started.url, 'wrong'), ORIGIN)).toBe(403);
    expect(await dial(withToken(started.url, started.id), ORIGIN)).toBe(403);

    expect(await send(withPair(started.url, started.id), KEY)).toEqual({ type: 'sidekick/ok' });
  });

  it('spends the request on a socket that sends no key', async () => {
    const started = await pairHub();

    expect(await send(withPair(started.url, started.id), { type: 'other' })).toBeUndefined();
    expect(await started.paired).toBeUndefined();
    expect(await dial(withPair(started.url, started.id), ORIGIN)).toBe(403);
  });

  it('expires, and refuses the request after', async () => {
    const started = await pairHub(50);

    expect(await started.paired).toBeUndefined();
    expect(await dial(withPair(started.url, started.id), ORIGIN)).toBe(403);
  });
});
