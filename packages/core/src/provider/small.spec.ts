import { describe, expect, it } from 'vitest';

import type { ProviderModel } from './definition';
import { pickTitleModel, smallModel } from './small';

function model(
  providerID: string,
  id: string,
  family?: string,
  variants: string[] = [],
): ProviderModel {
  return {
    providerID,
    id,
    name: id,
    route: '@ai-sdk/openai',
    ...(family ? { family } : {}),
    variants: variants.map((variant) => ({ id: variant, options: {} })),
  };
}

const MODELS = [
  model('anthropic', 'claude-sonnet-4-5', 'claude-sonnet'),
  model('anthropic', 'claude-haiku-4-5', 'claude-haiku', ['high', 'low']),
  model('google', 'gemini-2.5-flash', 'gemini-flash'),
  model('google', 'gemini-2.5-flash-lite', 'gemini-flash-lite', ['none', 'low']),
  model('openai', 'gpt-5', 'gpt'),
];

describe('smallModel', () => {
  it('takes the first family in v2’s order, from the given provider only', () => {
    expect(smallModel(MODELS, 'google')?.id).toBe('gemini-2.5-flash-lite');
    expect(smallModel(MODELS, 'anthropic')?.id).toBe('claude-haiku-4-5');
    expect(smallModel(MODELS, 'openai')).toBeUndefined();
  });
});

describe('pickTitleModel', () => {
  it('picks the title agent’s own model first', () => {
    expect(
      pickTitleModel({
        agentModel: 'openai/gpt-5-nano',
        sessionModel: 'anthropic/claude-sonnet-4-5',
        models: MODELS,
      }),
    ).toBe('openai/gpt-5-nano');
  });

  it('then the session provider’s small model, at its least reasoning', () => {
    expect(
      pickTitleModel({ sessionModel: 'anthropic/claude-sonnet-4-5#high', models: MODELS }),
    ).toBe('anthropic/claude-haiku-4-5#low');

    expect(pickTitleModel({ sessionModel: 'google/gemini-2.5-flash', models: MODELS })).toBe(
      'google/gemini-2.5-flash-lite#none',
    );
  });

  it('then the session’s own model', () => {
    expect(pickTitleModel({ sessionModel: 'openai/gpt-5#high', models: MODELS })).toBe(
      'openai/gpt-5#high',
    );
  });
});
