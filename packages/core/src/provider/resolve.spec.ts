import { generateText, type LanguageModelMiddleware } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { providers } from '../registry';
import { installFakeChrome } from '../testing/fakeChrome';
import { registerBuiltinProviders } from './builtin';
import type { CatalogModel, CatalogSlice } from './catalog-source';
import { updateProviderSetting } from './connection';
import { credentials } from './credentials';
import type { ProviderDefinition } from './definition';
import { toUserMessage } from './errors';
import { listEndpointTest } from './key-test';
import { resolveModel } from './resolve';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('./fetch', () => ({ privateFetch: network }));

const STOP = 'stop here';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, tool_call: true, limit: { context: 128_000, output: 32_000 }, ...extra };
}

function provider(id: string, npm: string, models: CatalogModel[]) {
  return {
    id,
    name: id,
    npm,
    models: Object.fromEntries(models.map((entry) => [entry.id, entry])),
  };
}

const effort = { reasoning_options: [{ type: 'effort' as const, values: ['low', 'high'] }] };

const CATALOG: CatalogSlice = {
  openai: provider('openai', '@ai-sdk/openai', [
    model('gpt-5', effort),
    model('odd', { provider: { npm: '@ai-sdk/cohere' } }),
  ]),
  anthropic: provider('anthropic', '@ai-sdk/anthropic', [model('claude-sonnet-4-5')]),
  google: provider('google', '@ai-sdk/google', [model('gemini-2.5-pro')]),
  openrouter: provider('openrouter', '@openrouter/ai-sdk-provider', [
    model('openai/gpt-5', effort),
  ]),
  xai: provider('xai', '@ai-sdk/xai', [model('grok-4')]),
  groq: provider('groq', '@ai-sdk/groq', [model('llama-4')]),
  mistral: provider('mistral', '@ai-sdk/mistral', [model('mistral-large')]),
};

function refuse() {
  network.mockImplementation((input) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.endsWith('/models')) {
      return Promise.resolve(
        Response.json({ data: [{ id: 'llama3' }], models: [{ type: 'llm', key: 'qwen' }] }),
      );
    }

    return Promise.resolve(Response.json({ error: { message: STOP } }, { status: 400 }));
  });
}

function sent(call = network.mock.calls.length - 1) {
  const [input, init] = network.mock.calls[call] ?? [];

  return {
    url: String(input instanceof Request ? input.url : input),
    headers: new Headers(init?.headers),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

async function send(ref: string) {
  const error = await generateText({
    model: await resolveModel(ref, CATALOG),
    prompt: 'hi',
    maxRetries: 0,
  }).catch((caught: unknown) => caught);

  return { error: toUserMessage(error), ...sent() };
}

const connect = (providerID: string, key = `${providerID}-key`) =>
  credentials.add({ providerID, label: providerID, value: { type: 'key', key } });

let disposers: (() => void)[] = [];

beforeEach(() => {
  installFakeChrome();
  network.mockReset();
  refuse();
  disposers = [registerBuiltinProviders()];
});

afterEach(() => {
  for (const dispose of disposers) dispose();

  vi.unstubAllGlobals();
});

describe('resolveModel routes', () => {
  it.each([
    ['openai/gpt-5', 'https://api.openai.com/v1/responses', 'authorization', 'Bearer openai-key'],
    [
      'anthropic/claude-sonnet-4-5',
      'https://api.anthropic.com/v1/messages',
      'x-api-key',
      'anthropic-key',
    ],
    [
      'google/gemini-2.5-pro',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      'x-goog-api-key',
      'google-key',
    ],
    [
      'openrouter/openai/gpt-5',
      'https://openrouter.ai/api/v1/chat/completions',
      'authorization',
      'Bearer openrouter-key',
    ],
    ['xai/grok-4', 'https://api.x.ai/v1/responses', 'authorization', 'Bearer xai-key'],
    [
      'groq/llama-4',
      'https://api.groq.com/openai/v1/chat/completions',
      'authorization',
      'Bearer groq-key',
    ],
    [
      'mistral/mistral-large',
      'https://api.mistral.ai/v1/chat/completions',
      'authorization',
      'Bearer mistral-key',
    ],
  ])('sends %s to %s with the active key', async (ref, url, header, value) => {
    await connect(ref.slice(0, ref.indexOf('/')));

    const result = await send(ref);

    expect(result.url).toBe(url);
    expect(result.headers.get(header)).toBe(value);
    expect(result.error).toBe(STOP);
  });

  it.each([
    ['ollama/llama3', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['lmstudio/qwen', 'http://127.0.0.1:1234/v1/chat/completions'],
  ])('sends keyless %s to the local server once connected', async (ref, url) => {
    const providerID = ref.slice(0, ref.indexOf('/'));

    await expect(resolveModel(ref, CATALOG)).rejects.toThrow(`Model unavailable: ${ref}`);

    await updateProviderSetting(providerID, { connected: true });

    const result = await send(ref);

    expect(result.url).toBe(url);
    expect(result.headers.get('authorization')).toBeNull();
  });

  it('always sends Anthropic’s browser header', async () => {
    await connect('anthropic');

    const { headers } = await send('anthropic/claude-sonnet-4-5');

    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
  });

  it('follows an edited base URL', async () => {
    await updateProviderSetting('ollama', { connected: true, baseURL: 'http://10.0.0.2:11434/v1' });

    expect((await send('ollama/llama3')).url).toBe('http://10.0.0.2:11434/v1/chat/completions');
  });
});

describe('resolveModel variants', () => {
  it('writes the variant as the route’s providerOptions', async () => {
    await connect('openai');
    await connect('openrouter');

    expect((await send('openai/gpt-5#high')).body.reasoning).toEqual({
      effort: 'high',
      summary: 'auto',
    });

    expect((await send('openrouter/openai/gpt-5#low')).body.reasoning).toEqual({ effort: 'low' });
  });

  it('sends no reasoning settings without a variant', async () => {
    await connect('openai');

    expect((await send('openai/gpt-5')).body.reasoning).toBeUndefined();
  });
});

describe('resolveModel refusals', () => {
  it.each([
    ['an unknown provider', 'nobody/gpt-5', 'Model unavailable: nobody/gpt-5'],
    ['a provider with no key', 'groq/llama-4', 'Model unavailable: groq/llama-4'],
    ['a model the catalog lacks', 'openai/gpt-0', 'Model unavailable: openai/gpt-0'],
    ['a model with no bundled route', 'openai/odd', 'Model unavailable: openai/odd'],
    ['an unknown variant', 'openai/gpt-5#max', 'Unknown variant "max" for gpt-5'],
    ['a bad reference', 'openai/', 'Invalid model reference: openai/'],
  ])('refuses %s before any request', async (_case, ref, message) => {
    await connect('openai');

    await expect(resolveModel(ref, CATALOG)).rejects.toThrow(message);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('resolveModel requests', () => {
  it('reads the active key on each resolve', async () => {
    await connect('openai', 'first');

    const second = await connect('openai', 'second');

    expect((await send('openai/gpt-5')).headers.get('authorization')).toBe('Bearer first');

    await credentials.activate(second.id);

    expect((await send('openai/gpt-5')).headers.get('authorization')).toBe('Bearer second');
  });

  it('keeps the captured fetch after globalThis.fetch is patched', async () => {
    const patched = vi.fn(() => Promise.reject(new Error('patched fetch saw the key')));

    vi.stubGlobal('fetch', patched);
    await connect('openai');

    expect((await send('openai/gpt-5')).error).toBe(STOP);
    expect(patched).not.toHaveBeenCalled();
  });

  it('lets a user registration replace a built-in', async () => {
    const builtin = providers.get('openai');

    if (!builtin) throw new Error('openai is not registered');

    disposers.push(
      providers.register('user', (draft) =>
        draft.add({ ...builtin, baseURL: 'https://proxy.test/v1' }),
      ),
    );

    await connect('openai');

    expect((await send('openai/gpt-5')).url).toBe('https://proxy.test/v1/responses');
  });

  it('merges provider headers and settings under the model’s, then applies wrapFetch and middleware', async () => {
    const transformParams = vi.fn<NonNullable<LanguageModelMiddleware['transformParams']>>(
      ({ params }) => Promise.resolve({ ...params, temperature: 0.25 }),
    );

    const definition: ProviderDefinition = {
      id: 'proxy',
      name: 'Proxy',
      route: '@ai-sdk/openai-compatible',
      baseURL: 'https://proxy.test/v1',
      auth: 'none',
      headers: { 'x-provider': 'provider', 'x-shared': 'provider' },
      settings: { queryParams: { tenant: 'acme', region: 'us' } },
      testKey: listEndpointTest({ path: '/models' }),
      listModels: () =>
        Promise.resolve([
          {
            id: 'm',
            headers: { 'x-shared': 'model' },
            settings: { queryParams: { region: 'eu' } },
          },
        ]),
      wrapFetch: (inner) => (input, init) =>
        inner(input, { ...init, headers: { ...init?.headers, 'x-wrapped': 'yes' } }),
      middleware: { transformParams },
    };

    disposers.push(providers.register('user', (draft) => draft.add(definition)));
    await updateProviderSetting('proxy', { connected: true });

    const { url, headers, body } = await send('proxy/m');

    expect(url).toBe('https://proxy.test/v1/chat/completions?tenant=acme&region=eu');
    expect(headers.get('x-provider')).toBe('provider');
    expect(headers.get('x-shared')).toBe('model');
    expect(headers.get('x-wrapped')).toBe('yes');
    expect(body.temperature).toBe(0.25);
    expect(transformParams).toHaveBeenCalledOnce();
  });

  it('keeps the provider’s message on a 404 model_not_found', async () => {
    const message = 'The model `gpt-5` does not exist or you do not have access to it.';

    network.mockResolvedValue(
      Response.json(
        { error: { message, type: 'invalid_request_error', code: 'model_not_found' } },
        { status: 404 },
      ),
    );

    await connect('openai');

    expect((await send('openai/gpt-5')).error).toBe(message);
  });
});
