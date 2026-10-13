import { describe, expect, it } from 'vitest';

import type { CatalogModel, ReasoningOption } from './catalog-source';
import { findVariant, modelVariants, reasoningLevels } from './variant';

function model(id: string, reasoning_options?: ReasoningOption[], output = 64_000): CatalogModel {
  return { id, name: id, tool_call: true, limit: { context: 200_000, output }, reasoning_options };
}

const effort = (...values: (string | null)[]): ReasoningOption => ({ type: 'effort', values });

describe('modelVariants', () => {
  it('has none without reasoning options or a known route', () => {
    expect(modelVariants('@ai-sdk/openai', model('gpt-4o'))).toEqual([]);
    expect(modelVariants('@ai-sdk/cohere', model('command', [effort('low')]))).toEqual([]);
  });

  it('writes OpenAI efforts as Responses options', () => {
    expect(modelVariants('@ai-sdk/openai', model('gpt-5', [effort('low', 'xhigh')]))).toEqual([
      { id: 'low', options: { reasoningEffort: 'low', reasoningSummary: 'auto' } },
      { id: 'xhigh', options: { reasoningEffort: 'xhigh', reasoningSummary: 'auto' } },
    ]);
  });

  it('writes adaptive thinking with effort for current Claude models', () => {
    const [low] = modelVariants('@ai-sdk/anthropic', model('claude-sonnet-4-6', [effort('low')]));

    expect(low).toEqual({
      id: 'low',
      options: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'low' },
    });
  });

  it('writes budget thinking for manual Claude models, capped at 32k', () => {
    const variants = modelVariants(
      '@ai-sdk/anthropic',
      model('claude-sonnet-4-5', [{ type: 'budget_tokens', min: 1024 }]),
    );

    expect(variants).toEqual([
      { id: 'high', options: { thinking: { type: 'enabled', budgetTokens: 16_000 } } },
      { id: 'max', options: { thinking: { type: 'enabled', budgetTokens: 31_999 } } },
    ]);
  });

  it('puts a toggle off-switch first for Claude', () => {
    const ids = modelVariants(
      '@ai-sdk/anthropic',
      model('claude-opus-4-7', [{ type: 'toggle' }, effort('low', 'max')]),
    ).map(({ id }) => id);

    expect(ids).toEqual(['none', 'low', 'max']);
  });

  it('writes Gemini thinking levels and budgets', () => {
    expect(modelVariants('@ai-sdk/google', model('gemini-3-pro', [effort('low')]))).toEqual([
      { id: 'low', options: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } } },
    ]);

    expect(
      modelVariants('@ai-sdk/google', model('gemini-2.5-flash', [{ type: 'toggle' }])),
    ).toEqual([
      { id: 'none', options: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } },
      {
        id: 'thinking',
        options: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
      },
    ]);
  });

  it('writes OpenRouter reasoning as body fields', () => {
    expect(
      modelVariants('@openrouter/ai-sdk-provider', model('openai/gpt-5', [effort('high')])),
    ).toEqual([{ id: 'high', options: { reasoning: { effort: 'high' } } }]);
  });

  it.each([
    ['@ai-sdk/xai', ['none', 'low', 'high', 'xhigh']],
    ['@ai-sdk/groq', ['none', 'low', 'high']],
    ['@ai-sdk/mistral', ['none', 'high']],
    ['@ai-sdk/openai-compatible', ['none', 'low', 'high', 'xhigh', 'max']],
  ])('keeps only the efforts %s accepts, as reasoningEffort', (npm, ids) => {
    const variants = modelVariants(
      npm,
      model('m', [effort('none', 'default', null, 'null', 'low', 'high', 'xhigh', 'max')]),
    );

    expect(variants.map(({ id }) => id)).toEqual(ids);
    expect(variants[0]?.options).toEqual({ reasoningEffort: 'none' });
  });
});

describe('findVariant', () => {
  it('returns a known variant and throws on an unknown one', () => {
    const gpt5 = model('gpt-5', [effort('low', 'high')]);

    expect(findVariant('@ai-sdk/openai', gpt5, 'high').options).toMatchObject({
      reasoningEffort: 'high',
    });

    expect(() => findVariant('@ai-sdk/openai', gpt5, 'max')).toThrow(
      'Unknown variant "max" for gpt-5',
    );
  });
});

describe('reasoningLevels', () => {
  it('labels variants for the model selector', () => {
    const variants = modelVariants('@ai-sdk/openai', model('gpt-5', [effort('none', 'xhigh')]));

    expect(reasoningLevels(variants)).toEqual([
      { key: 'none', label: 'None' },
      { key: 'xhigh', label: 'Extra high' },
    ]);
  });
});
