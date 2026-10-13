import { afterAll, expect, it, vi } from 'vitest';

import { privateFetch } from './fetch';

const atLoad = vi.hoisted(() => {
  const original = globalThis.fetch;
  const fetch = vi.fn((_input: string | URL | Request) => Promise.resolve(new Response('loaded')));

  globalThis.fetch = fetch;

  return { original, fetch };
});

afterAll(() => {
  globalThis.fetch = atLoad.original;
});

it('keeps the fetch from module load after globalThis.fetch is patched', async () => {
  const patched = vi.fn(() => Promise.resolve(new Response('patched')));

  globalThis.fetch = patched;

  const response = await privateFetch('https://api.openai.com/v1/models');

  expect(await response.text()).toBe('loaded');
  expect(atLoad.fetch).toHaveBeenCalledWith('https://api.openai.com/v1/models');
  expect(patched).not.toHaveBeenCalled();
});
