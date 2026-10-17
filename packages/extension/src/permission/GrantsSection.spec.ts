import { permissionGrants, webSearchProvider } from '@frogbotai/sidekick-core';
import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { describe, expect, it } from 'vitest';

import { revokeGrant, siteFromInput } from './GrantsSection';

describe('the grants section', () => {
  it('reads a typed site the way the engine names it', () => {
    expect(siteFromInput('WWW.Bank.example/login')).toBe('bank.example');
    expect(siteFromInput('localhost:3000')).toBe('localhost:3000');
    expect(siteFromInput('')).toBeUndefined();
    expect(siteFromInput('file:///etc')).toBeUndefined();
  });

  it('forgets the search provider with the websearch grant, so its card shows again', async () => {
    installFakeChrome();

    await permissionGrants.set([
      { action: 'websearch', resource: '*', created: 1 },
      { action: 'input', resource: 'github.com', created: 1 },
    ]);

    await webSearchProvider.set('random');
    await revokeGrant('input', 'github.com');

    expect(await webSearchProvider.get()).toBe('random');

    await revokeGrant('websearch', '*');

    expect(await permissionGrants.get()).toEqual([]);
    expect(await webSearchProvider.get()).toBeUndefined();
  });
});
