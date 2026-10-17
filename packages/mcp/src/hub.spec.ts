import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type Hub, refusal, startHub, STORE_EXTENSION_ID } from './hub.js';

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
