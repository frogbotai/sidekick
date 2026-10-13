import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import type { wrapLanguageModel } from 'ai';

import type { Fetch } from './definition';

/** What a route's factory gets: the merged settings, the active key and the request middleware's `fetch`. */
export interface RouteInput {
  providerID: string;
  baseURL?: string;
  apiKey?: string;
  headers: Record<string, string>;
  settings: Record<string, unknown>;
  fetch: Fetch;
}

/** An AI SDK language model, as every route's factory returns. */
export type LanguageModel = ReturnType<typeof wrapLanguageModel>;

/** A bundled AI SDK factory for one catalog `npm` package. */
export interface Route {
  optionsKey: (providerID: string) => string;
  create: (input: RouteInput) => (modelID: string) => LanguageModel;
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function common({ baseURL, apiKey, headers, settings, fetch }: RouteInput) {
  return {
    ...settings,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    headers,
    fetch,
  };
}

const fixed = (key: string, create: Route['create']): Route => ({ optionsKey: () => key, create });

function compatible(defaultBaseURL?: string): Route {
  return {
    optionsKey: (providerID) => providerID,
    create: (input) => {
      const baseURL = input.baseURL ?? defaultBaseURL;

      if (!baseURL) throw new Error(`${input.providerID} needs a base URL`);

      const provider = createOpenAICompatible({
        ...common(input),
        name: input.providerID,
        baseURL,
        includeUsage: true,
      });

      return (modelID) => provider.chatModel(modelID);
    },
  };
}

export const ROUTES: Readonly<Record<string, Route>> = {
  '@ai-sdk/openai': fixed('openai', (input) => createOpenAI(common(input))),
  '@ai-sdk/anthropic': fixed('anthropic', (input) => createAnthropic(common(input))),
  '@ai-sdk/google': fixed('google', (input) => createGoogle(common(input))),
  '@ai-sdk/xai': fixed('xai', (input) => createXai(common(input))),
  '@ai-sdk/groq': fixed('groq', (input) => createGroq(common(input))),
  '@ai-sdk/mistral': fixed('mistral', (input) => createMistral(common(input))),
  '@ai-sdk/openai-compatible': compatible(),
  '@openrouter/ai-sdk-provider': compatible(OPENROUTER_BASE_URL),
};

export function routeOf(npm: string): Route | undefined {
  return Object.hasOwn(ROUTES, npm) ? ROUTES[npm] : undefined;
}
