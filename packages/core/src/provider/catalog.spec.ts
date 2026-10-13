import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../storage';
import {
  CATALOG_REFRESH_MS,
  CATALOG_TTL_MS,
  CATALOG_URL,
  fallbackCatalog,
  loadCatalog,
  refreshCatalog,
  startCatalogRefresh,
} from './catalog';
import fallbackJson from './catalog.fallback.json';
import { sliceCatalog } from './catalog-source';

const IDS = ['openai'];

const gpt5 = {
  id: 'gpt-5',
  name: 'GPT-5',
  family: 'gpt',
  release_date: '2026-08-01',
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  limit: { context: 400_000, output: 128_000 },
  cost: { input: 1.25, output: 10 },
};

function body(models: Record<string, unknown> = { 'gpt-5': gpt5 }) {
  return {
    openai: { id: 'openai', name: 'OpenAI', npm: '@ai-sdk/openai', env: [], models },
    cohere: { id: 'cohere', name: 'Cohere', npm: '@ai-sdk/cohere', models: { c: gpt5 } },
  };
}

type Reply = { status: number; json?: unknown; etag?: string } | Error;

function stubFetch(...replies: Reply[]) {
  const fetch = vi.fn((_url: string, _init?: RequestInit) => {
    const reply = replies.shift();

    if (!reply) throw new Error('unexpected fetch');

    if (reply instanceof Error) return Promise.reject(reply);

    const headers = reply.etag ? { etag: reply.etag } : undefined;
    const text = reply.json === undefined ? null : JSON.stringify(reply.json);

    return Promise.resolve(new Response(text, { status: reply.status, headers }));
  });

  vi.stubGlobal('fetch', fetch);

  return fetch;
}

const sent = (fetch: ReturnType<typeof stubFetch>, call: number) =>
  new Headers(fetch.mock.calls[call]?.[1]?.headers).get('If-None-Match');

let database: IDBDatabase;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));
  database = await openDatabase();
});

afterEach(() => {
  database.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sliceCatalog', () => {
  it('keeps registered providers and their chat models with tools, trimmed', () => {
    const slice = sliceCatalog(
      body({
        'gpt-5': gpt5,
        old: { ...gpt5, id: 'old', status: 'deprecated' },
        beta: { ...gpt5, id: 'beta', status: 'beta' },
        whisper: { ...gpt5, id: 'whisper', tool_call: false },
        tts: { ...gpt5, id: 'tts', modalities: { input: ['text'], output: ['audio'] } },
        broken: { id: 'broken' },
      }),
      ['openai', 'missing'],
    );

    expect(Object.keys(slice)).toEqual(['openai']);
    expect(Object.keys(slice.openai?.models ?? {})).toEqual(['gpt-5', 'beta']);
    expect(slice.openai?.models['gpt-5']).not.toHaveProperty('cost');
    expect(slice.openai).not.toHaveProperty('env');
  });

  it('drops reasoning options it does not know', () => {
    const options = [{ type: 'effort', values: ['low'] }, { type: 'future' }];
    const slice = sliceCatalog(body({ 'gpt-5': { ...gpt5, reasoning_options: options } }), IDS);

    expect(slice.openai?.models['gpt-5']?.reasoning_options).toEqual([
      { type: 'effort', values: ['low'] },
    ]);
  });
});

describe('the bundled fallback', () => {
  it('is at most 50 KB minified and covers every catalog-backed launch provider', () => {
    expect(JSON.stringify(fallbackJson).length).toBeLessThanOrEqual(50 * 1024);

    expect(Object.keys(fallbackCatalog).sort()).toEqual(
      ['anthropic', 'google', 'groq', 'mistral', 'openai', 'openrouter', 'xai'].sort(),
    );

    for (const provider of Object.values(fallbackCatalog)) {
      expect(Object.keys(provider.models).length).toBeGreaterThan(0);
    }
  });
});

describe('loadCatalog and refreshCatalog', () => {
  it('starts on the fallback when nothing is cached', async () => {
    expect(await loadCatalog(database)).toBe(fallbackCatalog);
  });

  it('stores a fetched slice and skips fetching while it is fresh', async () => {
    const fetch = stubFetch({ status: 200, json: body(), etag: '"a"' });

    expect(await refreshCatalog({ database, catalogIDs: IDS })).toBe('updated');
    expect(fetch).toHaveBeenCalledWith(CATALOG_URL, expect.anything());
    expect(sent(fetch, 0)).toBeNull();
    expect(Object.keys((await loadCatalog(database)).openai?.models ?? {})).toEqual(['gpt-5']);

    vi.advanceTimersByTime(CATALOG_REFRESH_MS - 1);

    expect(await refreshCatalog({ database, catalogIDs: IDS })).toBe('fresh');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a 304 as unchanged and moves fetchedAt only', async () => {
    const fetch = stubFetch({ status: 200, json: body(), etag: '"a"' }, { status: 304 });

    await refreshCatalog({ database, catalogIDs: IDS });
    vi.advanceTimersByTime(CATALOG_REFRESH_MS);

    expect(await refreshCatalog({ database, catalogIDs: IDS })).toBe('unchanged');
    expect(sent(fetch, 1)).toBe('"a"');
    expect(await refreshCatalog({ database, catalogIDs: IDS })).toBe('fresh');
  });

  it('treats a body with the same slice as unchanged, keeping the new etag', async () => {
    const fetch = stubFetch(
      { status: 200, json: body(), etag: '"a"' },
      { status: 200, json: { ...body(), other: {} }, etag: '"b"' },
      { status: 304 },
    );

    await refreshCatalog({ database, catalogIDs: IDS });
    vi.advanceTimersByTime(CATALOG_REFRESH_MS);

    expect(await refreshCatalog({ database, catalogIDs: IDS })).toBe('unchanged');

    vi.advanceTimersByTime(CATALOG_REFRESH_MS);
    await refreshCatalog({ database, catalogIDs: IDS });

    expect(sent(fetch, 2)).toBe('"b"');
  });

  it.each([
    ['a network error', new Error('offline')],
    ['a 500', { status: 500 }],
    ['a body that is not JSON', { status: 200 }],
  ])('keeps the cache after %s', async (_name, failure) => {
    stubFetch({ status: 200, json: body(), etag: '"a"' }, failure);

    await refreshCatalog({ database, catalogIDs: IDS });
    vi.advanceTimersByTime(CATALOG_REFRESH_MS);

    expect(await refreshCatalog({ database, catalogIDs: IDS })).toBe('failed');
    expect(Object.keys(await loadCatalog(database))).toEqual(['openai']);
  });

  it('refetches without the etag when the registered providers change', async () => {
    const fetch = stubFetch(
      { status: 200, json: body(), etag: '"a"' },
      { status: 200, json: body(), etag: '"a"' },
    );

    await refreshCatalog({ database, catalogIDs: IDS });

    expect(await refreshCatalog({ database, catalogIDs: ['openai', 'cohere'] })).toBe('updated');
    expect(sent(fetch, 1)).toBeNull();
    expect(Object.keys(await loadCatalog(database))).toEqual(['openai', 'cohere']);
  });

  it('falls back once the cached slice is past its 30-day TTL', async () => {
    stubFetch({ status: 200, json: body(), etag: '"a"' });

    await refreshCatalog({ database, catalogIDs: IDS });
    vi.advanceTimersByTime(CATALOG_TTL_MS);

    expect(await loadCatalog(database)).toBe(fallbackCatalog);
  });
});

describe('startCatalogRefresh', () => {
  it('refreshes at once, then every 5 minutes, reporting only new slices', async () => {
    const changed = { ...body(), openai: { ...body().openai, name: 'OpenAI 2' } };
    const fetch = stubFetch(
      { status: 200, json: body(), etag: '"a"' },
      { status: 304 },
      { status: 200, json: changed, etag: '"b"' },
    );

    const onUpdate = vi.fn();
    const stop = startCatalogRefresh({ database, catalogIDs: IDS, onUpdate });

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));

    vi.advanceTimersByTime(CATALOG_REFRESH_MS);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    vi.advanceTimersByTime(CATALOG_REFRESH_MS);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));

    expect(onUpdate.mock.calls[1]?.[0].openai.name).toBe('OpenAI 2');

    stop();
    vi.advanceTimersByTime(CATALOG_REFRESH_MS);

    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
