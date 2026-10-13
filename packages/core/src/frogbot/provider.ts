import type { LanguageModelMiddleware } from 'ai';
import { APICallError } from 'ai';
import { z } from 'zod';

import type { CatalogModel, CatalogSlice } from '../provider/catalog-source';
import type {
  Fetch,
  ListedModel,
  ProviderDefinition,
  ProviderRequest,
} from '../provider/definition';
import { bearer, failure, listEndpointTest } from '../provider/key-test';
import {
  FROGBOT_HEADERS,
  FROGBOT_PROVIDER_ID,
  FROGBOT_URL,
  frogbotFailure,
  frogbotKey,
} from './client';
import { refreshQuota } from './quota';

const ServerModel = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  mode: z.string().optional(),
  context_length: z.number().nullable().optional(),
  max_output_tokens: z.number().nullable().optional(),
  reasoning: z.boolean().optional(),
});

const ModelList = z.object({ data: z.array(ServerModel) });

type ServerModel = z.infer<typeof ServerModel>;

function fromServer({ id, name, context_length, max_output_tokens, reasoning }: ServerModel) {
  const limit =
    typeof context_length === 'number' && typeof max_output_tokens === 'number'
      ? { context: context_length, output: max_output_tokens }
      : undefined;

  return {
    id,
    ...(name ? { name } : {}),
    ...(limit ? { limit } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function catalogEntry(catalog: CatalogSlice | undefined, id: string): CatalogModel | undefined {
  for (const provider of Object.values(catalog ?? {})) {
    const model = provider.models[id];

    if (model) return model;
  }
}

function fromCatalog(model: CatalogModel): ListedModel {
  return {
    id: model.id,
    name: model.name,
    limit: model.limit,
    reasoning: (model.reasoning_options?.length ?? 0) > 0,
  };
}

/**
 * FrogBot's chat models. A server that sends `mode` keeps its `chat` models with their metadata;
 * one that lists bare ids is joined to models.dev by id, and ids with no catalog entry are dropped.
 */
export async function frogbotModels({
  baseURL,
  key,
  headers,
  fetch,
  signal,
  catalog,
}: ProviderRequest): Promise<ListedModel[]> {
  const response = await fetch(`${baseURL}/models`, {
    headers: { ...headers, ...(key ? bearer(key) : {}) },
    credentials: 'omit',
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) throw new Error(await failure(response));

  const { data } = ModelList.parse(await response.json());

  if (data.some(({ mode }) => mode !== undefined)) {
    return data.filter(({ mode }) => mode === 'chat').map(fromServer);
  }

  return data.flatMap(({ id }) => {
    const model = catalogEntry(catalog, id);

    return model ? [fromCatalog(model)] : [];
  });
}

/** Sends every chat request without cookies, so only the key identifies the user. */
export function omitCredentials(fetch: Fetch): Fetch {
  return (input, init) => fetch(input, { ...init, credentials: 'omit' });
}

async function asFrogbotError(error: unknown) {
  if (!APICallError.isInstance(error) || error.statusCode === undefined) return error;

  const key = error.statusCode === 402 ? await frogbotKey() : undefined;

  return (
    (await frogbotFailure({
      url: error.url,
      status: error.statusCode,
      ...(error.responseHeaders ? { headers: error.responseHeaders } : {}),
      ...(error.responseBody === undefined ? {} : { body: error.responseBody }),
      ...(key ? { key } : {}),
    })) ?? error
  );
}

/** Maps 401, 402 and 429 to `FrogbotError`, and refreshes the balance after each turn. */
export const frogbotMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  wrapGenerate: async ({ doGenerate }) => {
    try {
      return await doGenerate();
    } catch (error) {
      throw await asFrogbotError(error);
    } finally {
      void refreshQuota();
    }
  },
  wrapStream: async ({ doStream }) => {
    let result: Awaited<ReturnType<typeof doStream>>;

    try {
      result = await doStream();
    } catch (error) {
      void refreshQuota();

      throw await asFrogbotError(error);
    }

    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          flush: () => void refreshQuota(),
        }),
      ),
    };
  },
};

/** The FrogBot account provider: Firmware's billed OpenAI-compatible API, signed with an `fb_api_` key. */
export const frogbotProvider: ProviderDefinition = {
  id: FROGBOT_PROVIDER_ID,
  name: 'FrogBot',
  route: '@ai-sdk/openai-compatible',
  baseURL: `${FROGBOT_URL}/api/v1`,
  auth: 'key',
  headers: { ...FROGBOT_HEADERS },
  testKey: listEndpointTest({ path: '/quota', badKey: [401] }),
  listModels: frogbotModels,
  wrapFetch: omitCredentials,
  middleware: frogbotMiddleware,
};
