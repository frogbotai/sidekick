import { openDatabase, providers } from '@frogbotai/sidekick-core';
import {
  type CatalogSlice,
  fallbackCatalog,
  loadCatalog,
  startCatalogRefresh,
} from '@frogbotai/sidekick-core/provider';
import { useSyncExternalStore } from 'react';

let current: CatalogSlice = fallbackCatalog;

const listeners = new Set<() => void>();

function publish(slice: CatalogSlice) {
  current = slice;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => void listeners.delete(listener);
}

export const currentCatalog = () => current;

/** Loads the cached catalog, else the bundled fallback, then refreshes it now and every 5 minutes. */
export async function startCatalog() {
  const database = await openDatabase();
  const catalogIDs = providers.list().flatMap(({ catalogID }) => (catalogID ? [catalogID] : []));

  publish(await loadCatalog(database));

  return startCatalogRefresh({ database, catalogIDs, onUpdate: publish });
}

export function useCatalog() {
  return useSyncExternalStore(subscribe, currentCatalog);
}
