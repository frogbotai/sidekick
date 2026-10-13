import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { providers } from '../registry';
import { installFakeChrome } from '../testing/fakeChrome';
import { BUILTIN_PROVIDERS, registerBuiltinProviders } from './builtin';
import { fallbackCatalog } from './catalog';
import { type CatalogSlice, SNAPSHOT_CATALOG_IDS } from './catalog-source';
import { connectionOf, providerSettings, updateProviderSetting } from './connection';
import { credentials } from './credentials';
import {
  addCustomProvider,
  customProviders,
  registerCustomProviders,
  removeCustomProvider,
} from './custom';
import type { ProviderDefinition } from './definition';
import { availableModels, providerModels } from './models';
import { routeOf } from './routes';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('./fetch', () => ({ privateFetch: network }));

const CATALOG: CatalogSlice = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    models: {
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        family: 'gpt',
        release_date: '2026-08-01',
        tool_call: true,
        limit: { context: 400_000, output: 128_000 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      embed: {
        id: 'embed',
        name: 'Unrouted',
        tool_call: true,
        limit: { context: 8000, output: 1000 },
        provider: { npm: '@ai-sdk/cohere' },
      },
    },
  },
};

const LISTS: Record<string, unknown> = {
  'http://127.0.0.1:11434/v1/models': { data: [{ id: 'llama3' }, { id: 'qwen3' }] },
  'http://127.0.0.1:1234/api/v1/models': {
    models: [
      { type: 'llm', key: 'qwen/qwen3-8b', display_name: 'Qwen3 8B' },
      { type: 'embedding', key: 'nomic-embed' },
    ],
  },
  'https://llm.example.test/v1/models': { data: [{ id: 'house-model' }] },
};

const urls = () => network.mock.calls.map(([input]) => String(input));

function definition(id: string): ProviderDefinition {
  const found = providers.get(id);

  if (!found) throw new Error(`${id} is not registered`);

  return found;
}

async function modelsOf(id: string, discover = false) {
  const provider = definition(id);
  const connection = await connectionOf(provider);

  if (!connection) throw new Error(`${id} is not connected`);

  return providerModels(provider, connection, { catalog: CATALOG, discover });
}

let disposers: (() => void)[] = [];

beforeEach(() => {
  installFakeChrome();
  network.mockReset();

  network.mockImplementation(async (input) => {
    const body = LISTS[String(input)];

    return body ? Response.json(body) : Promise.reject(new TypeError('Failed to fetch'));
  });

  disposers = [registerBuiltinProviders()];
});

afterEach(() => {
  for (const dispose of disposers) dispose();
});

describe('built-in providers', () => {
  it('registers FrogBot and the nine launch providers', () => {
    expect(providers.list().map(({ id }) => id)).toEqual([
      'frogbot',
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'xai',
      'groq',
      'mistral',
      'ollama',
      'lmstudio',
    ]);
  });

  it('bundles a fallback for exactly the catalog-backed built-ins, every one routed', () => {
    const catalogIDs = BUILTIN_PROVIDERS.flatMap(({ catalogID }) => (catalogID ? [catalogID] : []));

    expect(catalogIDs).toEqual([...SNAPSHOT_CATALOG_IDS]);
    expect(Object.keys(fallbackCatalog).sort()).toEqual([...catalogIDs].sort());
    expect(BUILTIN_PROVIDERS.filter(({ route }) => !routeOf(route))).toEqual([]);
  });

  it('lets a same-id user registration replace a built-in', () => {
    disposers.push(
      providers.register('user', (draft) => draft.add({ ...definition('groq'), name: 'My Groq' })),
    );

    expect(definition('groq').name).toBe('My Groq');
    expect(providers.list()).toHaveLength(BUILTIN_PROVIDERS.length);
  });
});

describe('catalog models', () => {
  it('lists the catalog’s routed models with their variants, without any request', async () => {
    await credentials.add({ providerID: 'openai', label: 'k', value: { type: 'key', key: 'k' } });

    const models = await modelsOf('openai');

    expect(models.map(({ id }) => id)).toEqual(['gpt-5']);

    expect(models[0]).toMatchObject({
      providerID: 'openai',
      name: 'GPT-5',
      route: '@ai-sdk/openai',
      family: 'gpt',
      release_date: '2026-08-01',
    });

    expect(models[0]?.variants.map(({ id }) => id)).toEqual(['low', 'high']);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('local servers', () => {
  it('discovers Ollama at {baseURL}/models, once until asked again', async () => {
    await updateProviderSetting('ollama', { connected: true });

    expect((await modelsOf('ollama')).map(({ id, name }) => [id, name])).toEqual([
      ['llama3', 'llama3'],
      ['qwen3', 'qwen3'],
    ]);

    await modelsOf('ollama');
    await modelsOf('ollama', true);

    expect(urls()).toEqual([
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:11434/v1/models',
    ]);
  });

  it('keeps LM Studio’s chat models only, with their display names', async () => {
    await updateProviderSetting('lmstudio', { connected: true });

    expect((await modelsOf('lmstudio')).map(({ id, name }) => [id, name])).toEqual([
      ['qwen/qwen3-8b', 'Qwen3 8B'],
    ]);
  });

  it('isn’t connected until the user connects it', async () => {
    expect(await connectionOf(definition('ollama'))).toBeUndefined();

    await updateProviderSetting('ollama', { connected: true });

    expect(await connectionOf(definition('ollama'))).toEqual({
      baseURL: 'http://127.0.0.1:11434/v1',
    });
  });
});

describe('custom providers', () => {
  it('adds an OpenAI-compatible provider with its key and lists {baseURL}/models', async () => {
    disposers.push(await registerCustomProviders());

    const entry = await addCustomProvider({
      name: 'House LLM',
      baseURL: 'https://llm.example.test/v1/',
      key: 'house-key',
    });

    await vi.waitFor(() => expect(providers.get('house-llm')).toBeDefined());

    expect(entry).toEqual({
      id: 'house-llm',
      name: 'House LLM',
      baseURL: 'https://llm.example.test/v1',
    });

    expect((await modelsOf('house-llm', true)).map(({ id }) => id)).toEqual(['house-model']);

    const [, init] = network.mock.calls.at(-1) ?? [];

    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer house-key');
  });

  it('never reuses a registered id', async () => {
    disposers.push(await registerCustomProviders());

    const first = await addCustomProvider({ name: 'OpenAI', baseURL: 'https://a.test/v1' });
    const second = await addCustomProvider({ name: 'OpenAI', baseURL: 'https://b.test/v1' });

    expect([first.id, second.id]).toEqual(['openai-2', 'openai-3']);
  });

  it('registers stored providers at start and forgets everything on remove', async () => {
    await customProviders.set([
      { id: 'house', name: 'House', baseURL: 'https://llm.example.test/v1' },
    ]);

    await updateProviderSetting('house', { connected: true });
    await credentials.add({ providerID: 'house', label: 'k', value: { type: 'key', key: 'k' } });
    disposers.push(await registerCustomProviders());

    expect(definition('house').route).toBe('@ai-sdk/openai-compatible');

    await removeCustomProvider('house');

    await vi.waitFor(() => expect(providers.get('house')).toBeUndefined());

    expect(await credentials.list('house')).toEqual([]);
    expect(await providerSettings.get()).toEqual({});
  });
});

describe('availableModels', () => {
  it('lists connected providers only, and none for a server it can’t reach', async () => {
    await credentials.add({ providerID: 'openai', label: 'k', value: { type: 'key', key: 'k' } });
    await updateProviderSetting('ollama', { connected: true, baseURL: 'http://10.0.0.9:11434/v1' });
    await updateProviderSetting('lmstudio', { connected: true });

    const models = await availableModels({ catalog: CATALOG, discover: true });

    expect(models.map(({ providerID, id }) => `${providerID}/${id}`)).toEqual([
      'openai/gpt-5',
      'lmstudio/qwen/qwen3-8b',
    ]);
  });
});
