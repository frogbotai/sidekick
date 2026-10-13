import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { credentials } from '../provider/credentials';
import { installFakeChrome } from '../testing/fakeChrome';
import { FrogbotError, frogbotFetch } from './client';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

function sent(call = 0) {
  const [input, init] = network.mock.calls[call] ?? [];

  return { url: String(input), init, headers: new Headers(init?.headers) };
}

async function failure(path = '/v1/search') {
  return frogbotFetch(path, { method: 'POST' }).catch((error: unknown) => error);
}

beforeEach(async () => {
  installFakeChrome();
  network.mockReset();

  await credentials.add({
    providerID: 'frogbot',
    label: 'Sidekick',
    value: { type: 'key', key: 'fb_api_good' },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('frogbotFetch', () => {
  it('calls app.frogbot.ai with the key read now, the source header and no cookies', async () => {
    network.mockResolvedValue(Response.json({ ok: true }));

    await frogbotFetch('/v1/quota');

    const { url, init, headers } = sent();

    expect(url).toBe('https://app.frogbot.ai/api/v1/quota');
    expect(init?.credentials).toBe('omit');
    expect(headers.get('authorization')).toBe('Bearer fb_api_good');
    expect(headers.get('x-frogbot-source')).toBe('sidekick');
  });

  it('throws not-connected without a key, before any request', async () => {
    installFakeChrome();

    const error = await failure();

    expect(error).toBeInstanceOf(FrogbotError);
    expect(error).toMatchObject({ code: 'not-connected', message: 'FrogBot not connected' });
    expect(network).not.toHaveBeenCalled();
  });

  it('turns a 401 into "Reconnect FrogBot"', async () => {
    network.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const error = await failure();

    expect(error).toMatchObject({ code: 'reconnect', statusCode: 401, isRetryable: false });
    expect(String((error as Error).message)).toMatch(/Reconnect FrogBot/);
  });

  it('turns a 402 into out of credit, with the balance from one quota read and the top-up link', async () => {
    network
      .mockResolvedValueOnce(Response.json({ error: 'Insufficient credits' }, { status: 402 }))
      .mockResolvedValueOnce(Response.json({ balanceUSD: 0 }));

    const error = await failure();

    expect(error).toMatchObject({
      code: 'credit',
      balanceUSD: 0,
      topUpURL: 'https://app.frogbot.ai/billing',
    });

    expect((error as Error).message).toBe(
      'Out of FrogBot credit (balance $0.00). Top up at https://app.frogbot.ai/billing',
    );

    expect(sent(1).url).toBe('https://app.frogbot.ai/api/v1/quota');
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('turns a 429 into rate-limited, retrying after Retry-After', async () => {
    network.mockResolvedValue(
      Response.json(
        { error: 'Firmware rate limit exceeded', retryAfterSeconds: 12 },
        { status: 429, headers: { 'Retry-After': '30' } },
      ),
    );

    const error = await failure();

    expect(error).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 30,
      isRetryable: true,
    });

    expect((error as Error).message).toMatch(/Retry after 30 s/);
  });

  it('falls back to the body’s retryAfterSeconds', async () => {
    network.mockResolvedValue(Response.json({ retryAfterSeconds: 12 }, { status: 429 }));

    expect(await failure()).toMatchObject({ retryAfterSeconds: 12 });
  });

  it('returns any other answer as is', async () => {
    network.mockResolvedValue(Response.json({ error: 'Brave failed' }, { status: 502 }));

    const response = await frogbotFetch('/v1/search');

    expect(response.status).toBe(502);
  });
});
