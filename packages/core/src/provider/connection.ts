import { z } from 'zod';

import { providers } from '../registry';
import { defineStorageItem } from '../storage';
import { credentials } from './credentials';
import type { ProviderDefinition } from './definition';

const ProviderSetting = z.object({
  baseURL: z.url().optional(),
  connected: z.boolean().optional(),
});

/** One provider's local settings: a base URL override, and whether a keyless provider is connected. */
export type ProviderSetting = z.infer<typeof ProviderSetting>;

export const providerSettings = defineStorageItem(
  'providerSettings',
  z.record(z.string(), ProviderSetting),
  {},
);

/** What a call to a connected provider needs: where to send it and the active key, if any. */
export interface Connection {
  baseURL?: string;
  key?: string;
}

export async function updateProviderSetting(providerID: string, patch: ProviderSetting) {
  const all = await providerSettings.get();
  const next = { ...all[providerID], ...patch };

  await providerSettings.set({ ...all, [providerID]: next });
}

export async function forgetProviderSetting(providerID: string) {
  const { [providerID]: _forgotten, ...rest } = await providerSettings.get();

  await providerSettings.set(rest);
}

export async function baseURLOf(definition: ProviderDefinition) {
  return (await providerSettings.get())[definition.id]?.baseURL ?? definition.baseURL;
}

/** The provider's connection, or `undefined` when it has no active credential (or, keyless, isn't connected). */
export async function connectionOf(
  definition: ProviderDefinition,
): Promise<Connection | undefined> {
  const [settings, credential] = await Promise.all([
    providerSettings.get(),
    credentials.active(definition.id),
  ]);

  const setting = settings[definition.id];
  const connected = definition.auth === 'none' ? setting?.connected === true : Boolean(credential);

  if (!connected) return;

  const key = credential?.value.type === 'key' ? credential.value.key : credential?.value.access;
  const baseURL = setting?.baseURL ?? definition.baseURL;

  return { ...(baseURL ? { baseURL } : {}), ...(key ? { key } : {}) };
}

export async function connectedProviders() {
  const all = providers.list();
  const connections = await Promise.all(all.map(connectionOf));

  return all.flatMap((definition, index) => {
    const connection = connections[index];

    return connection ? [{ definition, connection }] : [];
  });
}
