import { z } from 'zod';

import { defineStorageItem } from '../storage';
import { frogbotKey, readBalance } from './client';

const Quota = z.object({ balanceUSD: z.number(), fetchedAt: z.number() });

/** FrogBot's last known balance. */
export type FrogbotQuota = z.infer<typeof Quota>;

export const frogbotQuota = defineStorageItem('frogbotQuota', Quota.nullable(), null);

/** Reads the balance with the given or connected key and stores it. Keeps the last value when the read fails. */
export async function refreshQuota(key?: string) {
  const used = key ?? (await frogbotKey());

  if (!used) return frogbotQuota.remove();

  const balanceUSD = await readBalance(used);

  if (balanceUSD !== undefined) await frogbotQuota.set({ balanceUSD, fetchedAt: Date.now() });
}
