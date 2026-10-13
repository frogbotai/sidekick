import { z } from 'zod';

import { providers } from '../registry';
import { defineStorageItem } from '../storage';
import { forgetProviderSetting, updateProviderSetting } from './connection';
import { credentials } from './credentials';
import type { ProviderDefinition } from './definition';
import { listEndpointTest } from './key-test';
import { openAIModels } from './local';

const CustomProvider = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  baseURL: z.url(),
});

/** A user-added OpenAI-compatible provider. Its key, if any, is a credential like any other. */
export type CustomProvider = z.infer<typeof CustomProvider>;

export interface AddCustomProvider {
  name: string;
  baseURL: string;
  key?: string;
}

export const customProviders = defineStorageItem('customProviders', z.array(CustomProvider), []);

export function customDefinition({ id, name, baseURL }: CustomProvider): ProviderDefinition {
  return {
    id,
    name,
    route: '@ai-sdk/openai-compatible',
    baseURL,
    auth: 'none',
    testKey: listEndpointTest({ path: '/models' }),
    listModels: openAIModels,
  };
}

function register(list: readonly CustomProvider[]) {
  return providers.register('user', (draft) => {
    for (const entry of list) draft.add(customDefinition(entry));
  });
}

/** Registers the stored custom providers, and again whenever they change. Returns the undo. */
export async function registerCustomProviders() {
  let dispose = register(await customProviders.get());

  const unwatch = customProviders.watch((list) => {
    dispose();
    dispose = register(list);
  });

  return () => {
    unwatch();
    dispose();
  };
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom'
  );
}

export async function addCustomProvider({ name, baseURL, key }: AddCustomProvider) {
  const stored = await customProviders.get();
  const base = slug(name);
  const taken = (id: string) =>
    Boolean(providers.get(id)) || stored.some((entry) => entry.id === id);

  let id = base;

  for (let suffix = 2; taken(id); suffix++) id = `${base}-${suffix}`;

  const entry = CustomProvider.parse({
    id,
    name: name.trim(),
    baseURL: baseURL.replace(/\/+$/, ''),
  });

  if (key) await credentials.add({ providerID: id, label: name, value: { type: 'key', key } });

  await updateProviderSetting(id, { connected: true });
  await customProviders.set([...stored, entry]);

  return entry;
}

export async function removeCustomProvider(id: string) {
  await customProviders.set((await customProviders.get()).filter((entry) => entry.id !== id));
  await forgetProviderSetting(id);

  for (const credential of await credentials.list(id)) await credentials.remove(credential.id);
}
