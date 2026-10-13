import { defaultSettingsMiddleware, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';

import { providers } from '../registry';
import type { CatalogSlice } from './catalog-source';
import { connectionOf } from './connection';
import { fetchFor } from './key-test';
import { providerModels } from './models';
import { formatModelRef, parseModelRef } from './ref';
import { type LanguageModel, routeOf } from './routes';

type Settings = Record<string, unknown>;

function isPlain(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSettings(under: Settings, over: Settings): Settings {
  const merged: Settings = { ...under };

  for (const [key, value] of Object.entries(over)) {
    const base = merged[key];

    merged[key] = isPlain(base) && isPlain(value) ? mergeSettings(base, value) : value;
  }

  return merged;
}

function unavailable(providerID: string, modelID: string) {
  return new Error(`Model unavailable: ${formatModelRef({ providerID, modelID })}`);
}

/**
 * Builds the AI SDK model for `provider/model#variant`, reading the active key now.
 * Throws "Model unavailable" for an unknown or unconnected provider or an unlisted model, and
 * "Unknown variant" for a variant the model lacks, all before any request.
 */
export async function resolveModel(ref: string, catalog: CatalogSlice): Promise<LanguageModel> {
  const { providerID, modelID, variant } = parseModelRef(ref);
  const definition = providers.get(providerID);
  const connection = definition && (await connectionOf(definition));

  if (!definition || !connection) throw unavailable(providerID, modelID);

  const models = await providerModels(definition, connection, { catalog });
  const model = models.find(({ id }) => id === modelID);
  const route = model && routeOf(model.route);

  if (!model || !route) throw unavailable(providerID, modelID);

  const chosen = variant && model.variants.find(({ id }) => id === variant);

  if (variant && !chosen) throw new Error(`Unknown variant "${variant}" for ${modelID}`);

  const language = route.create({
    providerID,
    ...(connection.baseURL ? { baseURL: connection.baseURL } : {}),
    ...(connection.key ? { apiKey: connection.key } : {}),
    headers: { ...definition.headers, ...model.headers },
    settings: mergeSettings(definition.settings ?? {}, model.settings ?? {}),
    fetch: fetchFor(definition),
  })(modelID);

  const middleware: LanguageModelMiddleware[] = [
    ...(chosen
      ? [
          defaultSettingsMiddleware({
            settings: { providerOptions: { [route.optionsKey(providerID)]: chosen.options } },
          }),
        ]
      : []),
    ...[definition.middleware ?? []].flat(),
  ];

  return middleware.length > 0 ? wrapLanguageModel({ model: language, middleware }) : language;
}
