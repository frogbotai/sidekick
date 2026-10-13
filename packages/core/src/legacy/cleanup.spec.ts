import { beforeEach, describe, expect, it } from 'vitest';

import { type FakeChrome, installFakeChrome } from '../testing/fakeChrome';
import { cleanupLegacy, cleanupLegacyPanel, LEGACY_KEYS, olderThan } from './cleanup';

const KEPT = { credentials: [], theme: 'dark' };

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();

  for (const key of LEGACY_KEYS) fake.data.set(key, 'old');

  for (const [key, value] of Object.entries(KEPT)) fake.data.set(key, value);
});

function panel() {
  const removed: string[] = [];
  const cookies: string[] = [];

  return {
    removed,
    cookies,
    origin: {
      localStorage: { removeItem: (key: string) => void removed.push(key) },
      document: {
        get cookie() {
          return '';
        },
        set cookie(value: string) {
          cookies.push(value);
        },
      },
    },
  };
}

describe('cleanupLegacy', () => {
  it('removes exactly the 0.8.x keys on an update from 0.8.3', async () => {
    await cleanupLegacy({ reason: 'update', previousVersion: '0.8.3' });

    expect(Object.fromEntries(fake.data)).toEqual({ ...KEPT, legacyPanelCleanup: true });
  });

  it.each([
    { reason: 'update', previousVersion: '0.9.0' },
    { reason: 'update', previousVersion: '0.10.1' },
    { reason: 'install' },
    { reason: 'chrome_update', previousVersion: '0.8.3' },
  ])('removes nothing for %j', async (details) => {
    await cleanupLegacy(details);

    expect(fake.data.size).toBe(LEGACY_KEYS.length + Object.keys(KEPT).length);
    expect(fake.data.has('legacyPanelCleanup')).toBe(false);
  });

  it('compares versions as numbers', () => {
    expect(olderThan('0.8.3', '0.9.0')).toBe(true);
    expect(olderThan('0.8.10', '0.9.0')).toBe(true);
    expect(olderThan('0.9', '0.9.0')).toBe(false);
    expect(olderThan('0.10.0', '0.9.0')).toBe(false);
  });
});

describe('cleanupLegacyPanel', () => {
  it('removes the panel’s input and sidebar cookie once, after an update', async () => {
    await cleanupLegacy({ reason: 'update', previousVersion: '0.8.3' });

    const first = panel();

    await cleanupLegacyPanel(first.origin);

    expect(first.removed).toEqual(['input']);
    expect(first.cookies).toEqual(['sidebar:state=; path=/; max-age=0']);
    expect(fake.data.has('legacyPanelCleanup')).toBe(false);

    const second = panel();

    await cleanupLegacyPanel(second.origin);

    expect(second.removed).toEqual([]);
    expect(second.cookies).toEqual([]);
  });

  it('does nothing on a fresh install', async () => {
    await cleanupLegacy({ reason: 'install' });

    const { origin, removed, cookies } = panel();

    await cleanupLegacyPanel(origin);

    expect([removed, cookies]).toEqual([[], []]);
  });
});
