import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CATALOG_TTL_MS, fallbackCatalog, loadCatalog } from '../provider/catalog';
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
  it('upgrades from 0 to 2, creating the cache and session stores', async () => {
    const database = await open();

    expect(database.name).toBe('sidekick');
    expect(database.version).toBe(2);

    expect([...database.objectStoreNames].sort()).toEqual([
      'cache',
      'events',
      'messages',
      'sessions',
    ]);
  });

  it('upgrades a version 1 database to 2, keeping its cache', async () => {
    const first = await open(UPGRADES.slice(0, 1));

    await putCached(first, 'models', { ids: ['a'] }, 60_000);
    first.close();

    const database = await open();

    expect(database.version).toBe(2);
    expect(await getCached(database, 'models')).toEqual({ ids: ['a'] });

    const order = database.transaction('messages').objectStore('messages').index('order');

    expect(order.keyPath).toEqual(['sessionID', 'seq']);
  });

  it('upgrades a version 1 database with a cached catalog, so the catalog still loads', async () => {
    const first = await open(UPGRADES.slice(0, 1));
    const slice = Object.fromEntries(Object.entries(fallbackCatalog).slice(0, 1));

    await putCached(
      first,
      'catalog',
      { slice, catalogIDs: ['openai'], etag: 'W/"1"', digest: 'abc', fetchedAt: 1 },
      CATALOG_TTL_MS,
    );

    first.close();

    expect(await loadCatalog(await open())).toEqual(slice);
  });

  it('upgrades while another panel holds the version 1 database, which closes for it', async () => {
    const other = await open(UPGRADES.slice(0, 1));

    await putCached(other, 'models', { ids: ['a'] }, 60_000);

    const [one, two] = await Promise.all([open(), open()]);

    expect([one.version, two.version]).toEqual([2, 2]);
    expect(await getCached(two, 'models')).toEqual({ ids: ['a'] });
    expect(() => other.transaction('cache')).toThrow();
  });

  it('runs only the upgrades past the stored version, in order', async () => {
    const ran: number[] = [];

    (await open()).close();

    const next: Upgrade[] = [
      ...UPGRADES,
      (database) => {
        ran.push(3);
        database.createObjectStore('later');
      },
      () => ran.push(4),
    ];

    const database = await open(next);

    expect(database.version).toBe(4);
    expect(ran).toEqual([3, 4]);
    expect([...database.objectStoreNames].sort()).toContain('later');
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
