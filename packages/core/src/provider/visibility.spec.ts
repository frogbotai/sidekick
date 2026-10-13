import { describe, expect, it } from 'vitest';

import { defaultModel, visibleModels } from './visibility';

const NOW = Date.parse('2026-10-11T00:00:00Z');

const models = [
  { providerID: 'openai', id: 'gpt-5', family: 'gpt', release_date: '2026-08-01' },
  { providerID: 'openai', id: 'gpt-5-mini', family: 'gpt', release_date: '2026-06-01' },
  { providerID: 'openai', id: 'gpt-4o', family: 'gpt-4o', release_date: '2024-05-13' },
  { providerID: 'openai', id: 'o9', family: 'o', release_date: 'soon' },
  { providerID: 'openai', id: 'solo', release_date: '2026-09-01' },
  { providerID: 'groq', id: 'gpt-oss', family: 'gpt', release_date: '2026-07-01' },
];

const ids = (list: readonly { providerID: string; id: string }[]) =>
  list.map(({ providerID, id }) => `${providerID}/${id}`);

describe('visibleModels', () => {
  it('keeps the newest per provider and family from the last 6 months, plus undated models', () => {
    expect(ids(visibleModels(models, { now: NOW }))).toEqual([
      'openai/gpt-5',
      'openai/o9',
      'openai/solo',
      'groq/gpt-oss',
    ]);
  });

  it('keeps pinned models and applies show and hide choices over the defaults', () => {
    const visible = visibleModels(models, {
      now: NOW,
      pinned: ['openai/gpt-4o', 'openai/solo'],
      choices: { 'openai/gpt-5-mini': 'show', 'openai/solo': 'hide', 'openai/gpt-5': 'hide' },
    });

    expect(ids(visible)).toEqual([
      'openai/gpt-5-mini',
      'openai/gpt-4o',
      'openai/o9',
      'groq/gpt-oss',
    ]);
  });
});

describe('defaultModel', () => {
  it('picks the newest by release date across providers', () => {
    expect(defaultModel(models)?.id).toBe('solo');
  });

  it('puts undated models last and keeps the first of a tie', () => {
    const undated = { providerID: 'ollama', id: 'llama' };
    const a = { providerID: 'openai', id: 'a', release_date: '2026-01-01' };
    const b = { providerID: 'groq', id: 'b', release_date: '2026-01-01' };

    expect(defaultModel([undated, a, b])).toBe(a);
    expect(defaultModel([undated])).toBe(undated);
    expect(defaultModel([])).toBeUndefined();
  });
});
