import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RegistryModule from '../registry';
import { installFakeChrome } from '../testing/fakeChrome';
import type * as ToolModule from '../tool/tool';
import type * as HttpModule from './http';
import type { SearchProvider } from './registry';
import type * as ServiceModule from './service';

type Service = typeof ServiceModule;

type Registry = typeof RegistryModule;

type Http = typeof HttpModule;

type Tool = typeof ToolModule;

let service: Service;
let registry: Registry;
let http: Http;
let tool: Tool;

const signal = new AbortController().signal;

function provide(id: string, search: SearchProvider['search'] = () => Promise.resolve([])) {
  const fn = vi.fn<SearchProvider['search']>(search);

  registry.searchProviders.register(id, (draft) =>
    draft.add({ id, name: id.toUpperCase(), search: fn }),
  );

  return fn;
}

const ok = (url: string) => () => Promise.resolve([{ url }]);

const limited = (retryAfter?: string) => () =>
  Promise.reject(new http.SearchHttpError(429, retryAfter));

function pick(index: number, of: number) {
  vi.spyOn(Math, 'random').mockReturnValue((index + 0.5) / of);
}

beforeEach(async () => {
  installFakeChrome();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));
  vi.resetModules();
  service = await import('./service');
  registry = await import('../registry');
  http = await import('./http');
  tool = await import('../tool/tool');
  await service.webSearch.select('random');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cooldownMillis', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');

  it('reads seconds, an HTTP date, or falls back to 60 s', () => {
    expect(service.cooldownMillis('30', now)).toBe(30_000);
    expect(service.cooldownMillis('0', now)).toBe(0);
    expect(service.cooldownMillis(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(service.cooldownMillis(new Date(now - 5_000).toUTCString(), now)).toBe(0);
    expect(service.cooldownMillis(undefined, now)).toBe(60_000);
    expect(service.cooldownMillis(' ', now)).toBe(60_000);
    expect(service.cooldownMillis('-1', now)).toBe(60_000);
    expect(service.cooldownMillis('soon', now)).toBe(60_000);
  });
});

describe('random', () => {
  it('sticks each session to one randomly picked provider', async () => {
    provide('a', ok('https://a/'));
    provide('b', ok('https://b/'));
    provide('c', ok('https://c/'));

    pick(2, 3);

    expect((await service.webSearch.query('q', signal, 's1')).provider).toBe('c');

    pick(0, 3);

    expect((await service.webSearch.query('q', signal, 's1')).provider).toBe('c');
    expect((await service.webSearch.query('q', signal, 's2')).provider).toBe('a');
    expect((await service.webSearch.selected('s1'))?.id).toBe('c');
  });

  it('cools a provider down for Retry-After seconds and retries an untried one', async () => {
    const a = provide('a', limited('30'));
    const b = provide('b', ok('https://b/'));

    pick(0, 2);

    expect(await service.webSearch.query('q', signal, 's1')).toEqual({
      provider: 'b',
      results: [{ url: 'https://b/' }],
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith('q', signal);

    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's2')).provider).toBe('b');
    expect(a).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    a.mockImplementation(ok('https://a/'));
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's3')).provider).toBe('a');
  });

  it('cools down until an HTTP-date Retry-After', async () => {
    const a = provide('a', limited(new Date(Date.now() + 120_000).toUTCString()));

    provide('b', ok('https://b/'));
    pick(0, 2);
    await service.webSearch.query('q', signal, 's1');

    vi.advanceTimersByTime(119_000);
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's2')).provider).toBe('b');

    vi.advanceTimersByTime(1_000);
    a.mockImplementation(ok('https://a/'));
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's3')).provider).toBe('a');
  });

  it('cools down 60 s when Retry-After is missing', async () => {
    const a = provide('a', limited());

    provide('b', ok('https://b/'));
    pick(0, 2);
    await service.webSearch.query('q', signal, 's1');

    a.mockImplementation(ok('https://a/'));
    vi.advanceTimersByTime(59_999);
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's2')).provider).toBe('b');

    vi.advanceTimersByTime(1);
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's3')).provider).toBe('a');
  });

  it('fails with the last rate-limit error when every provider is cooling or tried', async () => {
    const first = new http.SearchHttpError(429, '10');
    const last = new http.SearchHttpError(429, '20');

    provide('a', () => Promise.reject(first));
    provide('b', () => Promise.reject(last));
    pick(0, 2);

    await expect(service.webSearch.query('q', signal, 's1')).rejects.toBe(last);
  });

  it('keeps a session off a provider that is cooling down', async () => {
    const a = provide('a', ok('https://a/'));
    const b = provide('b', ok('https://b/'));

    pick(0, 2);
    await service.webSearch.query('q', signal, 's1');
    a.mockImplementation(limited('30'));
    await service.webSearch.query('q', signal, 's2');

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);

    expect((await service.webSearch.query('q', signal, 's1')).provider).toBe('b');
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('fails at once on any other error, with no fallback', async () => {
    const error = new http.SearchHttpError(500);
    const b = provide('b', ok('https://b/'));

    provide('a', () => Promise.reject(error));
    pick(1, 2);

    await expect(service.webSearch.query('q', signal, 's1')).rejects.toBe(error);
    expect(b).not.toHaveBeenCalled();
  });

  it('treats FrogBot’s rate_limited with retryAfterSeconds as a rate limit', async () => {
    const a = provide('a', () =>
      Promise.reject(new tool.ToolError('rate_limited', 'Slow down', { retryAfterSeconds: 5 })),
    );

    provide('b', ok('https://b/'));
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's1')).provider).toBe('b');

    vi.advanceTimersByTime(5_000);
    a.mockImplementation(ok('https://a/'));
    pick(0, 2);

    expect((await service.webSearch.query('q', signal, 's2')).provider).toBe('a');
  });

  it('does not fall back on rate_limited without retryAfterSeconds', async () => {
    const b = provide('b', ok('https://b/'));

    provide('a', () => Promise.reject(new tool.ToolError('rate_limited', 'Slow down')));
    pick(1, 2);

    await expect(service.webSearch.query('q', signal, 's1')).rejects.toMatchObject({
      code: 'rate_limited',
    });

    expect(b).not.toHaveBeenCalled();
  });

  it('forgets the oldest session past 100', async () => {
    provide('a', ok('https://a/'));
    provide('b', ok('https://b/'));

    pick(1, 2);
    await service.webSearch.query('q', signal, 'oldest');
    pick(1, 2);

    for (let index = 0; index < 100; index++) {
      await service.webSearch.query('q', signal, `s${index}`);
    }

    expect((await service.webSearch.selected('s99'))?.id).toBe('b');
    expect((await service.webSearch.selected('oldest'))?.id).toBe('a');
  });

  it('selected() picks nothing and starts no cooldown', async () => {
    const a = provide('a', ok('https://a/'));

    provide('b', ok('https://b/'));

    expect((await service.webSearch.selected('new'))?.id).toBe('a');
    expect(a).not.toHaveBeenCalled();
  });
});

describe('a picked provider', () => {
  it('never falls back on a rate limit', async () => {
    const b = provide('b', ok('https://b/'));

    provide('a', limited('30'));
    await service.webSearch.select('a');

    await expect(service.webSearch.query('q', signal, 's1')).rejects.toMatchObject({
      status: 429,
    });

    expect(b).not.toHaveBeenCalled();
  });
});
