import { defaultSettingsMiddleware } from 'ai';

import { frogbotProvider } from '../frogbot/provider';
import { providers } from '../registry';
import type { ProviderDefinition } from './definition';
import { bearer, listEndpointTest } from './key-test';
import { lmStudio, ollama } from './local';
import { claudeInfo } from './variant';

const ANTHROPIC_VERSION = '2023-06-01';

const cloud = (
  definition: Omit<ProviderDefinition, 'auth' | 'catalogID' | 'testKey'>,
  testKey: ProviderDefinition['testKey'] = listEndpointTest({ path: '/models' }),
): ProviderDefinition => ({ ...definition, auth: 'key', catalogID: definition.id, testKey });

/** The providers Sidekick ships with, in the order the Providers screen lists them. */
export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  frogbotProvider,
  cloud({
    id: 'openai',
    name: 'OpenAI',
    route: '@ai-sdk/openai',
    baseURL: 'https://api.openai.com/v1',
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions: { openai: { store: false } } },
    }),
  }),
  cloud(
    {
      id: 'anthropic',
      name: 'Anthropic',
      route: '@ai-sdk/anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      reasoning: (model) => (claudeInfo(model).manual ? 'keep' : undefined),
    },
    listEndpointTest({
      path: '/models?limit=1',
      auth: (key) => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }),
    }),
  ),
  cloud(
    {
      id: 'google',
      name: 'Google',
      route: '@ai-sdk/google',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    },
    listEndpointTest({
      path: '/models?pageSize=1',
      auth: (key) => ({ 'x-goog-api-key': key }),
      badKey: [400, 401, 403],
    }),
  ),
  cloud(
    {
      id: 'openrouter',
      name: 'OpenRouter',
      route: '@openrouter/ai-sdk-provider',
      baseURL: 'https://openrouter.ai/api/v1',
      cache: (model) => (model.id.startsWith('anthropic/') ? 'openai-compatible' : undefined),
    },
    listEndpointTest({ path: '/key', auth: bearer }),
  ),
  cloud(
    { id: 'xai', name: 'xAI', route: '@ai-sdk/xai', baseURL: 'https://api.x.ai/v1' },
    listEndpointTest({ path: '/models', badKey: [400, 401, 403] }),
  ),
  cloud({
    id: 'groq',
    name: 'Groq',
    route: '@ai-sdk/groq',
    baseURL: 'https://api.groq.com/openai/v1',
  }),
  cloud({
    id: 'mistral',
    name: 'Mistral',
    route: '@ai-sdk/mistral',
    baseURL: 'https://api.mistral.ai/v1',
  }),
  ollama,
  lmStudio,
];

export function registerBuiltinProviders() {
  return providers.register('builtin', (draft) => {
    for (const definition of BUILTIN_PROVIDERS) draft.add(definition);
  });
}
