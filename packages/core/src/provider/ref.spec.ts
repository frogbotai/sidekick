import { describe, expect, it } from 'vitest';

import { formatModelRef, isModelRef, parseModelRef } from './ref';

describe('parseModelRef', () => {
  it('reads provider, model and variant', () => {
    expect(parseModelRef('openai/gpt-5')).toEqual({ providerID: 'openai', modelID: 'gpt-5' });

    expect(parseModelRef('anthropic/claude-sonnet-4-6#high')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
      variant: 'high',
    });
  });

  it('keeps a `/` inside the model id', () => {
    expect(parseModelRef('openrouter/openai/gpt-4o-mini#low')).toEqual({
      providerID: 'openrouter',
      modelID: 'openai/gpt-4o-mini',
      variant: 'low',
    });
  });

  it.each(['p/', '/m', 'p/m#', 'p/m#a#b', 'p', '', 'p#x/m'])('refuses %j', (input) => {
    expect(() => parseModelRef(input)).toThrow(`Invalid model reference: ${input}`);
    expect(isModelRef(input)).toBe(false);
  });

  it('round-trips through formatModelRef', () => {
    for (const ref of ['openai/gpt-5', 'openrouter/openai/gpt-4o-mini#low']) {
      expect(formatModelRef(parseModelRef(ref))).toBe(ref);
    }
  });
});
