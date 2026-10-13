import { z } from 'zod';

import { getCached, putCached } from '../storage';
import fallbackJson from './catalog.fallback.json';
import { CatalogSlice, sliceCatalog } from './catalog-source';

export const CATALOG_URL = 'https://models.dev/api.json';

export const CATALOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const CATALOG_REFRESH_MS = 5 * 60 * 1000;

const CACHE_KEY = 'catalog';

const CatalogEntry = z.object({
  slice: CatalogSlice,
  catalogIDs: z.array(z.string()),
  etag: z.string().optional(),
  digest: z.string(),
  fetchedAt: z.number(),
});

type CatalogEntry = z.infer<typeof CatalogEntry>;

/** What a refresh did: skipped while fresh, kept the same slice, stored a new one, or failed. */
export type CatalogRefresh = 'fresh' | 'unchanged' | 'updated' | 'failed';

export interface CatalogRefreshOptions {
  database: IDBDatabase;
  catalogIDs: readonly string[];
  force?: boolean;
}

export interface CatalogWatchOptions extends Omit<CatalogRefreshOptions, 'force'> {
  onUpdate: (slice: CatalogSlice) => void;
}

export const fallbackCatalog: CatalogSlice = CatalogSlice.parse(fallbackJson);

async function readEntry(database: IDBDatabase) {
  const parsed = CatalogEntry.safeParse(await getCached(database, CACHE_KEY));

  return parsed.success ? parsed.data : undefined;
}

async function digestOf(slice: CatalogSlice) {
  const bytes = new TextEncoder().encode(JSON.stringify(slice));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameIDs(stored: readonly string[], wanted: readonly string[]) {
  return stored.length === wanted.length && wanted.every((id) => stored.includes(id));
}

function writeEntry(database: IDBDatabase, entry: CatalogEntry) {
  return putCached(database, CACHE_KEY, entry, CATALOG_TTL_MS);
}

export async function loadCatalog(database: IDBDatabase): Promise<CatalogSlice> {
  return (await readEntry(database))?.slice ?? fallbackCatalog;
}

export async function refreshCatalog({
  database,
  catalogIDs,
  force = false,
}: CatalogRefreshOptions): Promise<CatalogRefresh> {
  try {
    const stored = await readEntry(database);
    const cached = stored && sameIDs(stored.catalogIDs, catalogIDs) ? stored : undefined;
    const now = Date.now();

    if (!force && cached && now - cached.fetchedAt < CATALOG_REFRESH_MS) return 'fresh';

    const response = await fetch(CATALOG_URL, {
      headers: cached?.etag ? { 'If-None-Match': cached.etag } : {},
    });

    if (response.status === 304 && cached) {
      await writeEntry(database, { ...cached, fetchedAt: now });

      return 'unchanged';
    }

    if (!response.ok) return 'failed';

    const slice = sliceCatalog(await response.json(), catalogIDs);
    const digest = await digestOf(slice);
    const etag = response.headers.get('etag') ?? undefined;

    if (cached?.digest === digest) {
      await writeEntry(database, { ...cached, etag, fetchedAt: now });

      return 'unchanged';
    }

    await writeEntry(database, {
      slice,
      catalogIDs: [...catalogIDs],
      etag,
      digest,
      fetchedAt: now,
    });

    return 'updated';
  } catch {
    return 'failed';
  }
}

export function startCatalogRefresh({ onUpdate, ...options }: CatalogWatchOptions) {
  const run = async (force: boolean) => {
    if ((await refreshCatalog({ ...options, force })) !== 'updated') return;

    const slice = await loadCatalog(options.database).catch(() => undefined);

    if (slice) onUpdate(slice);
  };

  void run(false);

  const timer = setInterval(() => void run(true), CATALOG_REFRESH_MS);

  return () => clearInterval(timer);
}
