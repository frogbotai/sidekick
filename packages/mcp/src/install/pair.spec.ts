import { describe, expect, it } from 'vitest';

import { chromePairing } from './pair.js';

describe('chromePairing', () => {
  it('says pending promptly when Chrome starts but Sidekick never answers', async () => {
    const pairing = chromePairing({ SIDEKICK_CHROME: '/bin/true' }, { shownTimeout: 200 });
    const started = Date.now();

    expect(await pairing.pair(['Cursor'], () => undefined)).toEqual({ pending: 'extension' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('says pending when Chrome can’t be started', async () => {
    const pairing = chromePairing({ SIDEKICK_CHROME: '/nonexistent/chrome' });

    expect(await pairing.pair(['Cursor'], () => undefined)).toEqual({ pending: 'chrome' });
  });
});
