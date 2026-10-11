export type Upgrade = (database: IDBDatabase, transaction: IDBTransaction) => void;

const CACHE = 'cache';

export const UPGRADES: readonly Upgrade[] = [(database) => database.createObjectStore(CACHE)];

interface Cached {
  value: unknown;
  expires: number;
}

function settle<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
  });
}

export function openDatabase(upgrades: readonly Upgrade[] = UPGRADES, name = 'sidekick') {
  const request = indexedDB.open(name, upgrades.length);

  request.onupgradeneeded = (event) => {
    const { transaction } = request;

    if (!transaction) throw new Error('IndexedDB upgrade without a transaction');

    for (let version = event.oldVersion; version < upgrades.length; version++) {
      upgrades[version]?.(request.result, transaction);
    }
  };

  return settle(request).then((database) => {
    database.onversionchange = () => database.close();

    return database;
  });
}

export async function putCached(database: IDBDatabase, key: string, value: unknown, ttlMs: number) {
  const transaction = database.transaction(CACHE, 'readwrite');
  const entry: Cached = { value, expires: Date.now() + ttlMs };

  transaction.objectStore(CACHE).put(entry, key);

  await complete(transaction);
}

export async function getCached(database: IDBDatabase, key: string) {
  const transaction = database.transaction(CACHE, 'readwrite');
  const store = transaction.objectStore(CACHE);
  const entry = await settle<Cached | undefined>(store.get(key));

  if (!entry) return undefined;

  if (entry.expires > Date.now()) return entry.value;

  store.delete(key);

  await complete(transaction);

  return undefined;
}
