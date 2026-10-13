import { z } from 'zod';

import type { KeyTest, ListedModel, ProviderDefinition, ProviderRequest } from './definition';
import { bearer, failure, listEndpointTest } from './key-test';

const OpenAIList = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

const LMStudioList = z.object({
  models: z.array(
    z.object({ type: z.string(), key: z.string().min(1), display_name: z.string().optional() }),
  ),
});

const COMPATIBLE = '@ai-sdk/openai-compatible';

async function getJSON({ key, headers, fetch, signal }: ProviderRequest, url: string) {
  const response = await fetch(url, {
    headers: { ...headers, ...(key ? bearer(key) : {}) },
    signal,
  });

  if (!response.ok) throw new Error(await failure(response));

  return response.json();
}

/** Lists an OpenAI-compatible server's models from `{baseURL}/models`. */
export async function openAIModels(request: ProviderRequest): Promise<ListedModel[]> {
  const { data } = OpenAIList.parse(await getJSON(request, `${request.baseURL}/models`));

  return data.map(({ id }) => ({ id }));
}

async function lmStudioModels(request: ProviderRequest): Promise<ListedModel[]> {
  const { models } = LMStudioList.parse(
    await getJSON(request, new URL('/api/v1/models', request.baseURL).href),
  );

  return models
    .filter(({ type }) => type === 'llm')
    .map(({ key, display_name: name }) => ({ id: key, ...(name ? { name } : {}) }));
}

export function ollamaOriginsFix() {
  return `OLLAMA_ORIGINS=chrome-extension://${chrome.runtime.id}`;
}

const listsModels = listEndpointTest({ path: '/models' });

const ollamaTest = listEndpointTest({ path: '/models', originRefused: [403] });

export const ollama: ProviderDefinition = {
  id: 'ollama',
  name: 'Ollama',
  route: COMPATIBLE,
  baseURL: 'http://127.0.0.1:11434/v1',
  auth: 'none',
  testKey: async (request): Promise<KeyTest> => {
    const result = await ollamaTest(request);

    if (result.status !== 'origin-refused') return result;

    const fix = ollamaOriginsFix();

    return {
      status: 'origin-refused',
      message: `Ollama refused Sidekick. Set ${fix}, then restart Ollama.`,
      fix,
    };
  },
  listModels: openAIModels,
};

export const lmStudio: ProviderDefinition = {
  id: 'lmstudio',
  name: 'LM Studio',
  route: COMPATIBLE,
  baseURL: 'http://127.0.0.1:1234/v1',
  auth: 'none',
  testKey: listsModels,
  listModels: lmStudioModels,
};
