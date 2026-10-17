import { z } from 'zod';

/** The built-in providers' catalog ids, which `pnpm catalog:snapshot` bundles as the fallback. */
export const SNAPSHOT_CATALOG_IDS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'xai',
  'groq',
  'mistral',
] as const;

const ReasoningOption = z.discriminatedUnion('type', [
  z.object({ type: z.literal('effort'), values: z.array(z.string().nullable()).optional() }),
  z.object({ type: z.literal('toggle') }),
  z.object({
    type: z.literal('budget_tokens'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);

const ReasoningOptions = z.array(z.unknown()).transform((options) =>
  options.flatMap((option) => {
    const parsed = ReasoningOption.safeParse(option);

    return parsed.success ? [parsed.data] : [];
  }),
);

export const CatalogModel = z.object({
  id: z.string().min(1),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string().optional(),
  reasoning_options: ReasoningOptions.optional(),
  tool_call: z.boolean(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
  limit: z.object({ context: z.number(), input: z.number().optional(), output: z.number() }),
  status: z.string().optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
});

/** One models.dev model, trimmed to the fields Sidekick reads. */
export type CatalogModel = z.infer<typeof CatalogModel>;

/** How a model's reasoning can be set, from models.dev `reasoning_options`. */
export type ReasoningOption = z.infer<typeof ReasoningOption>;

const ProviderFields = {
  id: z.string().min(1),
  name: z.string(),
  npm: z.string(),
  api: z.string().optional(),
};

export const CatalogProvider = z.object({
  ...ProviderFields,
  models: z.record(z.string(), CatalogModel),
});

/** One models.dev provider with its usable models. */
export type CatalogProvider = z.infer<typeof CatalogProvider>;

export const CatalogSlice = z.record(z.string(), CatalogProvider);

/** The registered providers' part of models.dev, keyed by catalog id. */
export type CatalogSlice = z.infer<typeof CatalogSlice>;

const SourceProvider = z.object({ ...ProviderFields, models: z.record(z.string(), z.unknown()) });

function usable(model: CatalogModel) {
  return (
    model.status !== 'deprecated' &&
    model.tool_call &&
    (model.modalities?.output.includes('text') ?? true)
  );
}

export function sliceCatalog(body: unknown, catalogIDs: readonly string[]): CatalogSlice {
  const source = z.record(z.string(), z.unknown()).parse(body);
  const slice: CatalogSlice = {};

  for (const catalogID of catalogIDs) {
    const provider = SourceProvider.safeParse(source[catalogID]);

    if (!provider.success) continue;

    const models: Record<string, CatalogModel> = {};

    for (const [id, input] of Object.entries(provider.data.models)) {
      const model = CatalogModel.safeParse(input);

      if (model.success && usable(model.data)) models[id] = model.data;
    }

    const { id, name, npm, api } = provider.data;

    slice[catalogID] = { id, name, npm, ...(api ? { api } : {}), models };
  }

  return slice;
}
