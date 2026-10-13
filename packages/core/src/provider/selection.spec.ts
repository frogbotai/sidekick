import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type FakeChrome, installFakeChrome } from '../testing/fakeChrome';
import {
  effectiveSelection,
  modelVisibility,
  recentModels,
  selectedModel,
  selectModel,
} from './selection';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
});

describe('model selection', () => {
  it('stores the selected ref and keeps the 5 most recent models, newest first', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await selectModel(`openai/${id}`);

    await selectModel('openai/c#high');

    expect(await selectedModel.get()).toBe('openai/c#high');

    expect(await recentModels.get()).toEqual([
      'openai/c',
      'openai/f',
      'openai/e',
      'openai/d',
      'openai/b',
    ]);
  });

  it('reads an invalid stored ref as no selection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.data.set('model', 'openai/');

    expect(await selectedModel.get()).toBeNull();
  });

  it('stores show and hide choices per model', async () => {
    await modelVisibility.set({ 'openai/gpt-5': 'hide' });

    expect(await modelVisibility.get()).toEqual({ 'openai/gpt-5': 'hide' });
    await expect(modelVisibility.set({ openai: 'show' })).rejects.toThrow();
  });
});

describe('effectiveSelection', () => {
  const older = { providerID: 'openai', id: 'gpt-5', release_date: '2026-08-01', variants: [] };
  const newer = {
    providerID: 'anthropic',
    id: 'claude',
    release_date: '2026-09-01',
    variants: [{ id: 'high' }],
  };

  const available = [older, newer];

  it('keeps an available stored ref with its variant', () => {
    expect(
      effectiveSelection({ stored: 'anthropic/claude#high', available, visible: available }),
    ).toEqual({ ref: 'anthropic/claude#high', model: newer });
  });

  it('keeps a stored model the picker hides, and drops a variant it no longer has', () => {
    expect(effectiveSelection({ stored: 'openai/gpt-5#max', available, visible: [newer] })).toEqual(
      { ref: 'openai/gpt-5', model: older },
    );
  });

  it('defaults to the newest visible model when nothing is stored', () => {
    expect(effectiveSelection({ stored: null, available, visible: [older] })).toEqual({
      ref: 'openai/gpt-5',
      model: older,
    });
  });

  it('falls back to the default and names a vanished selection', () => {
    expect(effectiveSelection({ stored: 'groq/gone#high', available, visible: available })).toEqual(
      { ref: 'anthropic/claude', model: newer, missing: 'groq/gone' },
    );

    expect(effectiveSelection({ stored: 'groq/gone', available: [], visible: [] })).toEqual({
      missing: 'groq/gone',
    });
  });
});
