import { writeFileSync } from 'node:fs';

import { format, resolveConfig } from 'prettier';

import {
  sliceCatalog,
  SNAPSHOT_CATALOG_IDS as CATALOG_IDS,
} from '../packages/core/src/provider/catalog-source.ts';
import { visibleModels } from '../packages/core/src/provider/visibility.ts';

const SOURCE = 'https://models.dev/api.json';

const LIMIT = 50 * 1024;

const OUTPUT = new URL('../packages/core/src/provider/catalog.fallback.json', import.meta.url);

const response = await fetch(SOURCE);

if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);

const slice = sliceCatalog(await response.json(), CATALOG_IDS);

for (const provider of Object.values(slice)) {
  const models = Object.values(provider.models).map((model) => ({
    ...model,
    providerID: provider.id,
  }));

  const kept = new Set(visibleModels(models).map(({ id }) => id));

  provider.models = Object.fromEntries(
    Object.entries(provider.models).filter(([id]) => kept.has(id)),
  );
}

const missing = CATALOG_IDS.filter((id) => !slice[id]);

if (missing.length > 0) throw new Error(`models.dev has no ${missing.join(', ')}`);

const minified = JSON.stringify(slice);

if (minified.length > LIMIT) {
  throw new Error(`The fallback is ${minified.length} bytes minified, over ${LIMIT}`);
}

writeFileSync(OUTPUT, await format(minified, { parser: 'json', ...(await resolveConfig(OUTPUT)) }));

const counts = Object.values(slice).map(({ id, models }) => `${id} ${Object.keys(models).length}`);

console.log(`catalog:snapshot: ${minified.length} bytes minified; ${counts.join(', ')}`);
