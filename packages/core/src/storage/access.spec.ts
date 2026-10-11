import { describe, expect, it } from 'vitest';

import { installFakeChrome } from '../testing/fakeChrome';
import { restrictStorageToTrustedContexts } from './access';

describe('restrictStorageToTrustedContexts', () => {
  it('limits storage.local to trusted contexts', async () => {
    const fake = installFakeChrome();

    await restrictStorageToTrustedContexts();

    expect(fake.accessLevels).toEqual(['TRUSTED_CONTEXTS']);
  });
});
