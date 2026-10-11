import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCached, openDatabase, putCached, type Upgrade, UPGRADES } from './database';

const opened: IDBDatabase[] = [];

async function open(upgrades?: readonly Upgrade[]) {
  const database = await openDatabase(upgrades);

  opened.push(database);

  return database;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();

  vi.useRealTimers();
});

describe('openDatabase', () => {
  it('upgrades from 0 to 1, creating the cache store', async () => {
    const database = await open();

    expect(database.name).toBe('sidekick');
    expect(database.version).toBe(1);
    expect([...database.objectStoreNames]).toEqual(['cache']);
  });

  it('runs only the upgrades past the stored version, in order', async () => {
    const ran: number[] = [];

    (await open()).close();

    const next: Upgrade[] = [
      ...UPGRADES,
      (database) => {
        ran.push(2);
        database.createObjectStore('sessions');
      },
      () => ran.push(3),
    ];

    const database = await open(next);

    expect(database.version).toBe(3);
    expect(ran).toEqual([2, 3]);
    expect([...database.objectStoreNames].sort()).toEqual(['cache', 'sessions']);
  });
});

describe('cache', () => {
  it('returns a value until its ttl passes, then undefined', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T00:00:00Z'));

    const database = await open();

    await putCached(database, 'models', { ids: ['a'] }, 1000);

    expect(await getCached(database, 'models')).toEqual({ ids: ['a'] });

    vi.setSystemTime(new Date('2026-10-11T00:00:00.999Z'));

    expect(await getCached(database, 'models')).toEqual({ ids: ['a'] });

    vi.setSystemTime(new Date('2026-10-11T00:00:01Z'));

    expect(await getCached(database, 'models')).toBeUndefined();
    expect(await getCached(database, 'missing')).toBeUndefined();
  });
});
