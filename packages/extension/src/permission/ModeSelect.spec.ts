import { autoModeWarned } from '@frogbotai/sidekick-core';
import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { describe, expect, it } from 'vitest';

import { needsWarning } from './ModeSelect';

describe('the mode select', () => {
  it('warns on the first Auto pick only', async () => {
    installFakeChrome();

    expect(await needsWarning('plan')).toBe(false);
    expect(await needsWarning('auto')).toBe(true);

    await autoModeWarned.set(true);

    expect(await needsWarning('auto')).toBe(false);
  });
});
