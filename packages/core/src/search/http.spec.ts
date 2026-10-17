import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_RESPONSE_BYTES, SEARCH_TIMEOUT_MS, searchFetch, SearchHttpError } from './http';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

const URL_WITH_KEY = 'https://mcp.example/mcp?apiKey=secret-key';

function hang(_input: string | URL | Request, init?: RequestInit) {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);

  return error as Error;
}

beforeEach(() => {
  network.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('searchFetch', () => {
  it('returns the body and passes the request on', async () => {
    network.mockResolvedValue(new Response('hello'));

    expect(
      await searchFetch(URL_WITH_KEY, { method: 'POST' }, new AbortController().signal, 'Test'),
    ).toBe('hello');

    expect(network).toHaveBeenCalledWith(URL_WITH_KEY, expect.objectContaining({ method: 'POST' }));
  });

  it('throws SearchHttpError with the status and Retry-After, never the URL', async () => {
    network.mockResolvedValue(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }),
    );

    const error = await failure(
      searchFetch(URL_WITH_KEY, {}, new AbortController().signal, 'Test'),
    );

    expect(error).toBeInstanceOf(SearchHttpError);
    expect(error).toMatchObject({ status: 429, retryAfter: '30' });
    expect(error.message).toBe('Web search request failed (HTTP 429)');
    expect(error.message).not.toContain('secret-key');
  });

  it('fails a body over 1 MiB', async () => {
    network.mockResolvedValue(new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)));

    const error = await failure(
      searchFetch(URL_WITH_KEY, {}, new AbortController().signal, 'Test'),
    );

    expect(error.message).toBe(`Test response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  });

  it('reads a body of exactly 1 MiB', async () => {
    network.mockResolvedValue(new Response('x'.repeat(MAX_RESPONSE_BYTES)));

    expect(await searchFetch(URL_WITH_KEY, {}, new AbortController().signal, 'Test')).toHaveLength(
      MAX_RESPONSE_BYTES,
    );
  });

  it('times out after 25 s', async () => {
    vi.useFakeTimers();
    network.mockImplementation(hang);

    const pending = failure(searchFetch(URL_WITH_KEY, {}, new AbortController().signal, 'Test'));

    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS);

    expect((await pending).message).toBe('Test request timed out');
  });

  it('stops when the tool call is aborted', async () => {
    network.mockImplementation(hang);

    const controller = new AbortController();
    const pending = failure(searchFetch(URL_WITH_KEY, {}, controller.signal, 'Test'));

    controller.abort(new Error('stopped'));

    expect((await pending).message).toBe('stopped');
  });

  it('hides the network error, which can name the URL', async () => {
    network.mockRejectedValue(new TypeError(`Failed to fetch ${URL_WITH_KEY}`));

    const error = await failure(
      searchFetch(URL_WITH_KEY, {}, new AbortController().signal, 'Test'),
    );

    expect(error.message).toBe('Test request failed');
  });
});
