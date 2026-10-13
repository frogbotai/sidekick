import type { CatalogSlice } from './catalog-source';
import { connectedProviders, type Connection } from './connection';
import type { ProviderDefinition, ProviderModel } from './definition';
import { fetchFor, KEY_TEST_TIMEOUT_MS } from './key-test';
import { routeOf } from './routes';
import { modelVariants } from './variant';

export interface ModelListOptions {
  catalog: CatalogSlice;
  discover?: boolean;
}

const discovered = new Map<string, ProviderModel[]>();

function fromCatalog(definition: ProviderDefinition, catalog: CatalogSlice): ProviderModel[] {
  const source = definition.catalogID ? catalog[definition.catalogID] : undefined;

  return Object.values(source?.models ?? {}).flatMap((model) => {
    const route = model.provider?.npm ?? definition.route;

    if (!routeOf(route)) return [];

    return [
      {
        providerID: definition.id,
        id: model.id,
        name: model.name,
        route,
        ...(model.family ? { family: model.family } : {}),
        ...(model.release_date ? { release_date: model.release_date } : {}),
        variants: modelVariants(route, model),
      },
    ];
  });
}

async function discover(
  definition: ProviderDefinition,
  connection: Connection,
  catalog: CatalogSlice,
) {
  const { listModels } = definition;

  if (!listModels || !connection.baseURL || !routeOf(definition.route)) return [];

  const listed = await listModels({
    baseURL: connection.baseURL,
    ...(connection.key ? { key: connection.key } : {}),
    headers: definition.headers ?? {},
    fetch: fetchFor(definition),
    signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
    catalog,
  });

  return listed.map(({ name, ...model }) => ({
    ...model,
    providerID: definition.id,
    name: name ?? model.id,
    route: definition.route,
    variants: [],
  }));
}

/**
 * A connected provider's models: the catalog's for catalog-backed providers, else the server's own list.
 * Server lists are fetched once, then again only with `discover: true` (on connect and picker open).
 */
export async function providerModels(
  definition: ProviderDefinition,
  connection: Connection,
  { catalog, discover: fresh = false }: ModelListOptions,
): Promise<ProviderModel[]> {
  if (definition.catalogID) return fromCatalog(definition, catalog);

  const key = `${definition.id}\n${connection.baseURL ?? ''}\n${connection.key ?? ''}`;
  const cached = discovered.get(key);

  if (cached && !fresh) return cached;

  const models = await discover(definition, connection, catalog);

  discovered.set(key, models);

  return models;
}

/** Every connected provider's models. A server that can't be reached lists none. */
export async function availableModels(options: ModelListOptions) {
  const connected = await connectedProviders();

  const lists = await Promise.all(
    connected.map(({ definition, connection }) =>
      providerModels(definition, connection, options).catch(() => []),
    ),
  );

  return lists.flat();
}
