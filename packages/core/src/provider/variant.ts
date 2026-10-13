import type { CatalogModel, ReasoningOption } from './catalog-source';

/** A JSON value, as AI SDK `providerOptions` accept. */
export type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

/** One provider's `providerOptions` entry. */
export type JsonObject = { [key: string]: JsonValue };

/** A named reasoning setting for one model, applied as that provider's `providerOptions`. */
export interface Variant {
  id: string;
  options: JsonObject;
}

/** A reasoning stop for `@frogbotai/ui`'s `ModelSelector`. */
export interface ReasoningLevel {
  key: string;
  label: string;
}

type Support =
  { type: 'effort'; values?: readonly string[] } | Exclude<ReasoningOption, { type: 'effort' }>;

type Protocol = (model: CatalogModel, support: Support) => Variant[];

const EFFORTS = ['low', 'medium', 'high'];
const ADAPTIVE_THINKING = { type: 'adaptive', display: 'summarized' };
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000;

const LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  thinking: 'Thinking',
};

const efforts = (
  values: readonly string[],
  spell: (effort: string) => JsonObject,
  allowed?: readonly string[],
): Variant[] =>
  values
    .filter((effort) => !allowed || allowed.includes(effort))
    .map((effort) => ({ id: effort, options: spell(effort) }));

const toggle = (off: JsonObject, on: JsonObject): Variant[] => [
  { id: 'none', options: off },
  { id: 'thinking', options: on },
];

function budgets(
  model: CatalogModel,
  support: Extract<Support, { type: 'budget_tokens' }>,
  spell: (tokens: number) => JsonObject,
  ceiling = model.limit.output,
): Variant[] {
  const maximum = Math.min(support.max ?? ceiling - 1, model.limit.output - 1, ceiling - 1);

  if (maximum <= 0) return [];

  const high = Math.min(Math.max(support.min ?? 0, Math.floor((maximum + 1) / 2)), maximum);

  return [
    { id: 'high', options: spell(high) },
    { id: 'max', options: spell(maximum) },
  ];
}

function claudeInfo(model: CatalogModel) {
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(
    model.id,
  );

  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(
    model.id,
  );

  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase();
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1]);
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0);

  return {
    family,
    major,
    minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always:
      family === 'fable' ||
      family === 'mythos' ||
      model.id.toLowerCase().includes('mythos-preview'),
  };
}

function manualThinking(model: CatalogModel): JsonObject | undefined {
  const tokens = Math.min(16_000, model.limit.output - 1);

  if (tokens < 1024) return;

  return { type: 'enabled', budgetTokens: tokens };
}

const chat =
  (allowed?: readonly string[]): Protocol =>
  (_, support) => {
    if (support.type !== 'effort') return [];

    return efforts(support.values ?? EFFORTS, (effort) => ({ reasoningEffort: effort }), allowed);
  };

const openaiResponses: Protocol = (_, support) => {
  if (support.type !== 'effort') return [];

  return efforts(support.values ?? ['none', 'minimal', ...EFFORTS, 'xhigh'], (effort) => ({
    reasoningEffort: effort,
    reasoningSummary: 'auto',
  }));
};

const anthropicMessages: Protocol = (model, support) => {
  const info = claudeInfo(model);
  const opus45 = info.family === 'opus' && info.major === 4 && info.minor === 5;

  switch (support.type) {
    case 'effort': {
      if (info.manual && !opus45) {
        return anthropicMessages(model, { type: 'budget_tokens', min: 1024 });
      }

      const thinking = opus45 ? manualThinking(model) : ADAPTIVE_THINKING;

      if (!thinking) return [];

      const defaults =
        info.major === 4 && info.minor === 6 ? [...EFFORTS, 'max'] : [...EFFORTS, 'xhigh', 'max'];

      return efforts(support.values ?? defaults, (effort) => ({ thinking, effort }), [
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }

    case 'toggle': {
      if (info.always) return [];

      const thinking = info.manual ? manualThinking(model) : ADAPTIVE_THINKING;

      if (!thinking) return [];

      return toggle({ thinking: { type: 'disabled' } }, { thinking });
    }

    case 'budget_tokens':
      return budgets(
        model,
        support,
        (tokens) => ({ thinking: { type: 'enabled', budgetTokens: tokens } }),
        ANTHROPIC_OUTPUT_TOKEN_MAX,
      );
  }
};

const gemini: Protocol = (model, support) => {
  switch (support.type) {
    case 'effort':
      return efforts(
        support.values ?? EFFORTS,
        (effort) => ({ thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }),
        ['minimal', 'low', 'medium', 'high'],
      );

    case 'toggle':
      return toggle(
        { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } },
        { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
      );

    case 'budget_tokens':
      return budgets(model, support, (tokens) => ({
        thinkingConfig: { includeThoughts: true, thinkingBudget: tokens },
      }));
  }
};

const openrouter: Protocol = (model, support) => {
  switch (support.type) {
    case 'effort':
      return efforts(support.values ?? EFFORTS, (effort) => ({ reasoning: { effort } }));

    case 'toggle':
      return toggle({ reasoning: { enabled: false } }, { reasoning: { enabled: true } });

    case 'budget_tokens':
      return budgets(model, support, (tokens) => ({ reasoning: { max_tokens: tokens } }));
  }
};

const PROTOCOLS: Readonly<Record<string, Protocol>> = {
  '@ai-sdk/openai': openaiResponses,
  '@ai-sdk/anthropic': anthropicMessages,
  '@ai-sdk/google': gemini,
  '@ai-sdk/xai': chat(['none', 'low', 'medium', 'high', 'xhigh']),
  '@ai-sdk/groq': chat(['none', 'low', 'medium', 'high']),
  '@ai-sdk/mistral': chat(['none', 'high']),
  '@ai-sdk/openai-compatible': chat(),
  '@openrouter/ai-sdk-provider': openrouter,
};

function supports(model: CatalogModel): Support[] {
  return (model.reasoning_options ?? []).map((option) =>
    option.type === 'effort'
      ? {
          type: 'effort',
          values: option.values?.filter(
            (value): value is string => value !== null && value !== 'null' && value !== 'default',
          ),
        }
      : option,
  );
}

export function modelVariants(npm: string, model: CatalogModel): Variant[] {
  const protocol = PROTOCOLS[npm];

  if (!protocol) return [];

  const options = supports(model);
  const effort = options.find((option) => option.type === 'effort');
  const budget = options.find((option) => option.type === 'budget_tokens');
  const toggled = options.some((option) => option.type === 'toggle')
    ? protocol(model, { type: 'toggle' })
    : [];

  const main = effort ? protocol(model, effort) : budget ? protocol(model, budget) : toggled;
  const variants = [...toggled.filter(({ id }) => id === 'none'), ...main];

  return variants.filter(
    (variant, index) => variants.findIndex(({ id }) => id === variant.id) === index,
  );
}

export function findVariant(npm: string, model: CatalogModel, variantID: string): Variant {
  const variant = modelVariants(npm, model).find(({ id }) => id === variantID);

  if (!variant) throw new Error(`Unknown variant "${variantID}" for ${model.id}`);

  return variant;
}

export function reasoningLevels(variants: readonly Variant[]): ReasoningLevel[] {
  return variants.map(({ id }) => ({ key: id, label: LABELS[id] ?? id }));
}
