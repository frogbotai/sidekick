import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerBuiltinSearchProviders } from '../search/builtin';
import { installFakeChrome } from '../testing/fakeChrome';
import { addCustomProvider } from './custom';

let dispose: () => void;

beforeEach(() => {
  installFakeChrome();
  dispose = registerBuiltinSearchProviders();
});

afterEach(() => dispose());

describe('addCustomProvider', () => {
  it('never takes an id a search provider uses', async () => {
    const exa = await addCustomProvider({ name: 'Exa', baseURL: 'https://exa.test/v1' });
    const tavily = await addCustomProvider({ name: 'Tavily', baseURL: 'https://t.test/v1' });

    expect([exa.id, tavily.id]).toEqual(['exa-2', 'tavily-2']);
  });
});
