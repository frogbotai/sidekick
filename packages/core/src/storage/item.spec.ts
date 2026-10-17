import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type FakeChrome, installFakeChrome } from '../testing/fakeChrome';
import { defineStorageItem } from './item';
import { theme } from './items';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
  vi.restoreAllMocks();
});

describe('defineStorageItem', () => {
  it('round-trips a value through storage.local', async () => {
    const item = defineStorageItem('count', z.number(), 0);

    await item.set(3);

    expect(await item.get()).toBe(3);
    expect(fake.data.get('count')).toBe(3);

    await item.remove();

    expect(await item.get()).toBe(0);
    expect(fake.data.has('count')).toBe(false);
  });

  it('keeps a session item in storage.session, and watches only that area', async () => {
    const item = defineStorageItem('live', z.array(z.string()), [], 'session');
    const listener = vi.fn();
    const stop = item.watch(listener);

    await item.set(['a']);
    fake.emit({ live: { newValue: ['b'] } }, 'local');

    expect(fake.session.get('live')).toEqual(['a']);
    expect(fake.data.has('live')).toBe(false);
    expect(await item.get()).toEqual(['a']);
    expect(listener.mock.calls).toEqual([[['a']]]);

    stop();
  });

  it('reads a missing value as the fallback without logging', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await theme.get()).toBe('system');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a value that fails the schema as the fallback, logging once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item = defineStorageItem('mode', z.enum(['light', 'dark']), 'light');

    fake.data.set('mode', 'neon');

    expect(await item.get()).toBe('light');
    expect(await item.get()).toBe('light');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses to write a value that fails the schema', async () => {
    const item = defineStorageItem('count', z.number(), 0);

    await expect(item.set(Number.NaN)).rejects.toThrow();
    expect(fake.data.has('count')).toBe(false);
  });

  it('watches its own key in the local area only, until unsubscribed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const listener = vi.fn();
    const stop = theme.watch(listener);

    await theme.set('dark');
    await defineStorageItem('other', z.string(), '').set('x');
    fake.emit({ theme: { newValue: 'light' } }, 'sync');
    fake.emit({ theme: { newValue: 'neon' } }, 'local');
    await theme.remove();

    expect(listener.mock.calls).toEqual([['dark'], ['system'], ['system']]);

    stop();

    expect(fake.listenerCount()).toBe(0);
  });
});
