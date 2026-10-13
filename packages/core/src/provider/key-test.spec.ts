import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeChrome } from '../testing/fakeChrome';
import { BUILTIN_PROVIDERS } from './builtin';
import { updateProviderSetting } from './connection';
import type { ProviderDefinition } from './definition';
import { KEY_TEST_TIMEOUT_MS, testKey } from './key-test';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('./fetch', () => ({ privateFetch: network }));

const RUNTIME_ID = 'kilnglameccalibejghopglodbidhkmj';

function builtin(id: string): ProviderDefinition {
  const definition = BUILTIN_PROVIDERS.find((entry) => entry.id === id);

  if (!definition) throw new Error(`No built-in ${id}`);

  return definition;
}

function answer(status: number, body: unknown = {}) {
  network.mockResolvedValue(Response.json(body, { status }));
}

function sent() {
  const [input, init] = network.mock.calls.at(-1) ?? [];

  return { url: String(input), headers: new Headers(init?.headers) };
}

beforeEach(() => {
  installFakeChrome();
  Object.assign(chrome, { runtime: { id: RUNTIME_ID } });
  network.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('testKey requests', () => {
  it.each([
    ['openai', 'https://api.openai.com/v1/models', 'authorization', 'Bearer k'],
    ['anthropic', 'https://api.anthropic.com/v1/models?limit=1', 'x-api-key', 'k'],
    [
      'google',
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      'x-goog-api-key',
      'k',
    ],
    ['openrouter', 'https://openrouter.ai/api/v1/key', 'authorization', 'Bearer k'],
    ['xai', 'https://api.x.ai/v1/models', 'authorization', 'Bearer k'],
    ['groq', 'https://api.groq.com/openai/v1/models', 'authorization', 'Bearer k'],
    ['mistral', 'https://api.mistral.ai/v1/models', 'authorization', 'Bearer k'],
  ])('tests a %s key at %s', async (id, url, header, value) => {
    answer(200, { data: [] });

    expect(await testKey(builtin(id), { key: 'k' })).toEqual({ status: 'ok' });
    expect(sent().url).toBe(url);
    expect(sent().headers.get(header)).toBe(value);
  });

  it('sends Anthropic’s version and browser headers', async () => {
    answer(200);
    await testKey(builtin('anthropic'), { key: 'k' });

    expect(sent().headers.get('anthropic-version')).toBe('2023-06-01');
    expect(sent().headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
  });

  it('tests a keyless local server at its edited base URL', async () => {
    answer(200, { data: [] });
    await updateProviderSetting('ollama', { baseURL: 'http://10.0.0.2:11434/v1' });

    expect(await testKey(builtin('ollama'))).toEqual({ status: 'ok' });
    expect(sent().url).toBe('http://10.0.0.2:11434/v1/models');
    expect(sent().headers.get('authorization')).toBeNull();
  });

  it('asks for a key before calling a key provider', async () => {
    expect(await testKey(builtin('openai'))).toEqual({
      status: 'bad-key',
      message: 'Enter an API key',
    });

    expect(network).not.toHaveBeenCalled();
  });
});

describe('testKey results', () => {
  it.each([
    ['openai', 401],
    ['openai', 403],
    ['anthropic', 401],
    ['google', 400],
    ['xai', 400],
    ['groq', 401],
    ['mistral', 401],
    ['openrouter', 401],
  ])('calls a %s %i a bad key, with the provider’s message', async (id, status) => {
    answer(status, { error: { message: 'Invalid API key provided' } });

    expect(await testKey(builtin(id), { key: 'k' })).toEqual({
      status: 'bad-key',
      message: 'Invalid API key provided',
    });
  });

  it('calls an OpenAI 400 an error, not a bad key', async () => {
    answer(400, { error: { message: 'Bad request' } });

    expect(await testKey(builtin('openai'), { key: 'k' })).toEqual({
      status: 'error',
      message: 'Bad request',
    });
  });

  it('calls an Ollama 403 origin-refused and gives the OLLAMA_ORIGINS fix', async () => {
    network.mockResolvedValue(new Response(null, { status: 403 }));

    const fix = `OLLAMA_ORIGINS=chrome-extension://${RUNTIME_ID}`;

    expect(await testKey(builtin('ollama'))).toEqual({
      status: 'origin-refused',
      message: `Ollama refused Sidekick. Set ${fix}, then restart Ollama.`,
      fix,
    });
  });

  it('calls a network failure unreachable', async () => {
    network.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await testKey(builtin('lmstudio'))).toEqual({
      status: 'unreachable',
      message: "Couldn't reach http://127.0.0.1:1234/v1",
    });
  });

  it('gives up after 10 s and calls it unreachable', async () => {
    vi.useFakeTimers();

    network.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const result = testKey(builtin('groq'), { key: 'k' });

    await vi.advanceTimersByTimeAsync(KEY_TEST_TIMEOUT_MS);

    expect(await result).toEqual({ status: 'unreachable', message: "Groq didn't answer in 10 s" });
  });

  it('keeps an unexpected server error’s text', async () => {
    network.mockResolvedValue(new Response('upstream exploded', { status: 500 }));

    expect(await testKey(builtin('mistral'), { key: 'k' })).toEqual({
      status: 'error',
      message: 'upstream exploded',
    });
  });

  it('uses the provider’s request middleware', async () => {
    answer(200);

    const wrapped = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(new Response('{}')),
    );

    const definition = { ...builtin('openai'), wrapFetch: () => wrapped };

    expect(await testKey(definition, { key: 'k' })).toEqual({ status: 'ok' });
    expect(wrapped).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
  });
});
