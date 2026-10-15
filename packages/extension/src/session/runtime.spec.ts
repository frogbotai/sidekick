import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { describe, expect, it } from 'vitest';

import { openChat } from '.';

const SESSION = path.resolve(import.meta.dirname, '../../../core/src/session');

describe('the session engine', () => {
  it('imports no chrome.* and nothing worker-only, so it can move out of the panel', () => {
    const sources = readdirSync(SESSION).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
    );

    expect(sources).toContain('engine.ts');

    const offending = sources.filter((file) =>
      /\bchrome\s*\.|from '\.\.\/(browser|rpc|testing)\//.test(
        readFileSync(path.join(SESSION, file), 'utf8'),
      ),
    );

    expect(offending).toEqual([]);
  });
});

describe('openChat', () => {
  it('remembers one open chat per window in chrome.storage.session', async () => {
    const fake = installFakeChrome();

    await openChat.set(1, 'ses_a');
    await openChat.set(2, 'ses_b');

    expect(await openChat.get(1)).toBe('ses_a');
    expect(await openChat.get(2)).toBe('ses_b');
    expect(fake.session.get('openChat.1')).toBe('ses_a');

    await openChat.set(1, undefined);

    expect(await openChat.get(1)).toBeUndefined();
    expect(fake.data.size).toBe(0);
  });
});
