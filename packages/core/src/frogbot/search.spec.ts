import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { credentials } from '../provider/credentials';
import { searchProviders } from '../registry';
import { installFakeChrome } from '../testing/fakeChrome';
import { ToolError } from '../tool/tool';
import { disconnect } from './connect';
import { frogbotSearch, registerFrogbotSearch } from './search';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

const RESULTS = [
  {
    url: 'https://developer.chrome.com/docs/extensions/reference/api/offscreen',
    title: 'Offscreen',
    content: 'Use offscreen documents',
  },
];

const connect = () =>
  credentials.add({
    providerID: 'frogbot',
    label: 'Sidekick',
    value: { type: 'key', key: 'fb_api_good' },
  });

let disposers: (() => void)[] = [];

beforeEach(() => {
  installFakeChrome();
  network.mockReset();
  network.mockResolvedValue(Response.json({ results: RESULTS }));
  disposers = [];
});

afterEach(() => {
  for (const dispose of disposers) dispose();
});

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ToolError);

  return error as ToolError;
}

describe('FrogBot search', () => {
  it('POSTs the query to /api/v1/search with the key and no cookies', async () => {
    await connect();

    expect(await frogbotSearch('chrome mv3 offscreen', new AbortController().signal)).toEqual(
      RESULTS,
    );

    const [input, init] = network.mock.calls[0] ?? [];

    expect(String(input)).toBe('https://app.frogbot.ai/api/v1/search');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(JSON.parse(String(init?.body))).toEqual({ query: 'chrome mv3 offscreen' });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fb_api_good');
  });

  it('fails "FrogBot not connected" without a key', async () => {
    const error = await failure(frogbotSearch('q', new AbortController().signal));

    expect(error).toMatchObject({ code: 'not_connected', message: 'FrogBot not connected' });
    expect(network).not.toHaveBeenCalled();
  });

  it('fails "FrogBot not connected" when disconnected while the search is in flight', async () => {
    await connect();

    let answer: (response: Response) => void = () => undefined;

    network.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const pending = frogbotSearch('q', new AbortController().signal);

    await vi.waitFor(() => expect(network).toHaveBeenCalled());
    await disconnect();
    answer(Response.json({ results: RESULTS }));

    expect(await failure(pending)).toMatchObject({ code: 'not_connected' });
  });

  it.each([
    [401, {}, 'reconnect', /Reconnect FrogBot/],
    [402, {}, 'out_of_credit', /Out of FrogBot credit/],
    [429, { 'Retry-After': '20' }, 'rate_limited', /Retry after 20 s/],
  ])('turns a %i into a typed tool error', async (status, headers, code, text) => {
    await connect();

    network.mockImplementation((input) =>
      Promise.resolve(
        String(input).endsWith('/quota')
          ? Response.json({ balanceUSD: 0 })
          : Response.json({ error: 'refused' }, { status, headers }),
      ),
    );

    const error = await failure(frogbotSearch('q', new AbortController().signal));

    expect(error.code).toBe(code);
    expect(error.message).toMatch(text);
  });

  it('passes on the server’s words for any other failure', async () => {
    await connect();
    network.mockResolvedValue(Response.json({ error: 'Search request failed' }, { status: 502 }));

    expect(await failure(frogbotSearch('q', new AbortController().signal))).toMatchObject({
      code: 'request_failed',
      message: 'Search request failed',
    });
  });
});

describe('registerFrogbotSearch', () => {
  it('registers FrogBot while a FrogBot key is stored, and drops it on disconnect', async () => {
    const undo = registerFrogbotSearch();

    disposers.push(undo);
    await undo.ready;

    expect(searchProviders.list()).toEqual([]);

    await connect();

    expect(searchProviders.list().map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'frogbot', name: 'FrogBot' },
    ]);

    await disconnect();

    expect(searchProviders.list()).toEqual([]);
  });

  it('registers at once when already connected', async () => {
    await connect();

    const undo = registerFrogbotSearch();

    disposers.push(undo);
    await undo.ready;

    expect(searchProviders.get('frogbot')).toBeDefined();
  });
});
