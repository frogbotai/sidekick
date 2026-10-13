import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { credentials } from '../provider/credentials';
import { restrictStorageToTrustedContexts } from '../storage';
import { type FakeChrome, installFakeChrome } from '../testing/fakeChrome';
import {
  CONNECT_NONCE_TTL_MS,
  disconnect,
  FROGBOT_REVOKE_URL,
  listenForConnect,
  pasteKey,
  startConnect,
} from './connect';
import { frogbotQuota } from './quota';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (response: unknown) => void,
) => boolean;

const ORIGIN = 'https://app.frogbot.ai';

let fake: FakeChrome;
let listener: Listener | undefined;
let opened: string[] = [];

function accept(keys: Record<string, number>) {
  network.mockImplementation((_input, init) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const status = keys[auth.replace('Bearer ', '')] ?? 401;

    return Promise.resolve(
      Response.json(status === 200 ? { balanceUSD: 7 } : { error: 'Unauthorized' }, { status }),
    );
  });
}

beforeEach(() => {
  fake = installFakeChrome();
  network.mockReset();
  accept({ fb_api_good: 200 });
  opened = [];
  listener = undefined;

  Object.assign(chrome, {
    tabs: { create: ({ url }: { url: string }) => Promise.resolve(void opened.push(url)) },
    runtime: {
      onMessageExternal: {
        addListener: (added: Listener) => (listener = added),
        removeListener: () => (listener = undefined),
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function send(message: unknown, origin = ORIGIN) {
  if (!listener) throw new Error('Not listening');

  const reply = vi.fn();
  const kept = listener(message, { origin }, reply);

  if (kept) await vi.waitFor(() => expect(reply).toHaveBeenCalled());

  return { kept, reply: reply.mock.calls[0]?.[0] };
}

const message = (nonce: string, key = 'fb_api_good') => ({ type: 'frogbot.connect', nonce, key });

describe('paste a key', () => {
  it('stores a key FrogBot accepts, in storage.local, and reads the balance', async () => {
    await restrictStorageToTrustedContexts();

    expect(await pasteKey('  fb_api_good ')).toEqual({ status: 'ok' });

    const [stored] = await credentials.list('frogbot');

    expect(stored).toMatchObject({
      label: 'Sidekick',
      active: true,
      value: { type: 'key', key: 'fb_api_good' },
    });

    expect(fake.data.has('credentials')).toBe(true);
    expect(fake.accessLevels).toEqual(['TRUSTED_CONTEXTS']);
    expect(await frogbotQuota.get()).toMatchObject({ balanceUSD: 7 });
    expect(String(network.mock.calls[0]?.[0])).toBe('https://app.frogbot.ai/api/v1/quota');
  });

  it('refuses a key FrogBot answers 401 to', async () => {
    expect(await pasteKey('fb_api_bad')).toMatchObject({ status: 'bad-key' });
    expect(await credentials.list('frogbot')).toEqual([]);
  });
});

describe('disconnect', () => {
  it('removes every FrogBot key and the balance, and links to revoking the key', async () => {
    accept({ fb_api_good: 200, fb_api_other: 200 });
    await pasteKey('fb_api_good');
    await pasteKey('fb_api_other');
    await credentials.add({ providerID: 'openai', label: 'o', value: { type: 'key', key: 'sk' } });

    expect(await disconnect()).toBe(FROGBOT_REVOKE_URL);
    expect(FROGBOT_REVOKE_URL).toBe('https://app.frogbot.ai/collections/api-keys');
    expect(await credentials.list('frogbot')).toEqual([]);
    expect(await credentials.list('openai')).toHaveLength(1);
    expect(await frogbotQuota.get()).toBeNull();
  });
});

describe('connect through FrogBot’s page', () => {
  it('opens the connect page with a fresh nonce kept in storage.session', async () => {
    const nonce = await startConnect();

    expect(opened).toEqual([
      `https://app.frogbot.ai/connect/sidekick?nonce=${encodeURIComponent(nonce)}`,
    ]);

    expect(fake.session.get('frogbotConnectNonces')).toEqual([
      { nonce, issuedAt: expect.any(Number) },
    ]);

    expect(fake.data.has('frogbotConnectNonces')).toBe(false);
  });

  it('stores the key for the right origin and a live nonce', async () => {
    listenForConnect();

    const nonce = await startConnect();

    expect(await send(message(nonce))).toEqual({ kept: true, reply: { ok: true } });

    expect(await credentials.list('frogbot')).toEqual([
      expect.objectContaining({ label: 'Sidekick', value: { type: 'key', key: 'fb_api_good' } }),
    ]);
  });

  it.each([
    ['another origin', 'https://evil.example'],
    ['a look-alike origin', 'https://app.frogbot.ai.evil.example'],
  ])('ignores %s without a reply', async (_name, origin) => {
    listenForConnect();

    const nonce = await startConnect();

    expect(await send(message(nonce), origin)).toEqual({ kept: false, reply: undefined });
    expect(network).not.toHaveBeenCalled();
    expect(await credentials.list('frogbot')).toEqual([]);
  });

  it.each([
    { type: 'frogbot.connect', nonce: 'n' },
    { type: 'other', nonce: 'n', key: 'fb_api_good' },
    'frogbot.connect',
  ])('ignores the message %j without a reply', async (body) => {
    listenForConnect();
    await startConnect();

    expect(await send(body)).toEqual({ kept: false, reply: undefined });
  });

  it('stores nothing for a nonce it never issued', async () => {
    listenForConnect();
    await startConnect();

    expect((await send(message('made-up'))).reply).toEqual({ ok: false });
    expect(network).not.toHaveBeenCalled();
    expect(await credentials.list('frogbot')).toEqual([]);
  });

  it('stores nothing for a nonce older than 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    listenForConnect();

    const nonce = await startConnect();

    vi.setSystemTime(Date.now() + CONNECT_NONCE_TTL_MS);

    expect((await send(message(nonce))).reply).toEqual({ ok: false });
    expect(await credentials.list('frogbot')).toEqual([]);
  });

  it('stores nothing for a replayed nonce', async () => {
    listenForConnect();

    const nonce = await startConnect();

    expect((await send(message(nonce))).reply).toEqual({ ok: true });

    await disconnect();

    expect((await send(message(nonce))).reply).toEqual({ ok: false });
    expect(await credentials.list('frogbot')).toEqual([]);
  });

  it('stores nothing when FrogBot refuses the key', async () => {
    listenForConnect();

    const nonce = await startConnect();

    expect((await send(message(nonce, 'fb_api_bad'))).reply).toEqual({ ok: false });
    expect(await credentials.list('frogbot')).toEqual([]);
  });

  it('stops listening on undo', () => {
    const undo = listenForConnect();

    undo();

    expect(listener).toBeUndefined();
  });
});
