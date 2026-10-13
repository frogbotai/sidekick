import { z } from 'zod';

import { defineStorageItem } from '../storage';

/** The `storage.local` keys 0.8.x left behind: its auth cache, panel state and DOM map. */
export const LEGACY_KEYS = [
  'auth_user',
  'auth_token',
  'auth_token_exp',
  'current_domain',
  'side_panel_open_by_window',
  'elementsMap',
  'elementsMapUrl',
  'elementsMapTimestamp',
] as const;

export const FIRST_CLEAN_VERSION = '0.9.0';

/** Set by the worker after an update from 0.8.x, until the panel clears its own leftovers. */
export const legacyPanelCleanup = defineStorageItem('legacyPanelCleanup', z.boolean(), false);

function parts(version: string) {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/** Whether `version` is below `than`, comparing dotted numbers. */
export function olderThan(version: string, than: string) {
  const a = parts(version);
  const b = parts(than);

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);

    if (difference !== 0) return difference < 0;
  }

  return false;
}

/** On an update from below 0.9.0, removes 0.8.x's `storage.local` keys and flags the panel's leftovers. */
export async function cleanupLegacy({
  reason,
  previousVersion,
}: {
  reason: string;
  previousVersion?: string;
}) {
  if (reason !== 'update' || !previousVersion) return;

  if (!olderThan(previousVersion, FIRST_CLEAN_VERSION)) return;

  await chrome.storage.local.remove([...LEGACY_KEYS]);
  await legacyPanelCleanup.set(true);
}

/** What the panel cleanup touches: the panel's `localStorage` and `document`. */
export interface PanelOrigin {
  localStorage: Pick<Storage, 'removeItem'>;
  document: { cookie: string };
}

/** Removes 0.8.x's panel `localStorage` `input` and `sidebar:state` cookie, once, after an update. */
export async function cleanupLegacyPanel(origin: PanelOrigin) {
  if (!(await legacyPanelCleanup.get())) return;

  origin.localStorage.removeItem('input');
  origin.document.cookie = 'sidebar:state=; path=/; max-age=0';

  await legacyPanelCleanup.remove();
}
