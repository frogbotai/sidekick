import { z } from 'zod';

import { defineStorageItem } from '../storage';

const KeyValue = z.object({ type: z.literal('key'), key: z.string().min(1) });

const OAuthValue = z.object({
  type: z.literal('oauth'),
  methodID: z.string(),
  refresh: z.string(),
  access: z.string(),
  expires: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CredentialValue = z.discriminatedUnion('type', [KeyValue, OAuthValue]);

const Credential = z.object({
  id: z.string().min(1),
  providerID: z.string().min(1),
  label: z.string(),
  active: z.boolean(),
  value: CredentialValue,
});

/** An API key, or an OAuth token set for sign-in providers. */
export type CredentialValue = z.infer<typeof CredentialValue>;

/** One stored credential. At most one per provider is active. */
export type Credential = z.infer<typeof Credential>;

export interface AddCredential {
  providerID: string;
  label: string;
  value: CredentialValue;
  activate?: boolean;
}

const store = defineStorageItem('credentials', z.array(Credential), []);

function activateIn(all: readonly Credential[], providerID: string, id: string | undefined) {
  return all.map((entry) =>
    entry.providerID === providerID ? { ...entry, active: entry.id === id } : entry,
  );
}

export const credentials = {
  all: () => store.get(),

  list: async (providerID: string) =>
    (await store.get()).filter((entry) => entry.providerID === providerID),

  active: async (providerID: string) =>
    (await store.get()).find((entry) => entry.providerID === providerID && entry.active),

  add: async ({ providerID, label, value, activate = false }: AddCredential) => {
    const all = await store.get();
    const first = !all.some((entry) => entry.providerID === providerID);
    const entry: Credential = { id: crypto.randomUUID(), providerID, label, active: false, value };
    const next = [...all, entry];

    await store.set(first || activate ? activateIn(next, providerID, entry.id) : next);

    return { ...entry, active: first || activate };
  },

  activate: async (id: string) => {
    const all = await store.get();
    const entry = all.find((candidate) => candidate.id === id);

    if (!entry) throw new Error(`No credential ${id}`);

    await store.set(activateIn(all, entry.providerID, id));
  },

  remove: async (id: string) => {
    const all = await store.get();
    const entry = all.find((candidate) => candidate.id === id);

    if (!entry) return;

    const left = all.filter((candidate) => candidate.id !== id);
    const newest = left.findLast((candidate) => candidate.providerID === entry.providerID);

    await store.set(entry.active ? activateIn(left, entry.providerID, newest?.id) : left);
  },

  watch: (listener: (all: Credential[]) => void) => store.watch(listener),
};
