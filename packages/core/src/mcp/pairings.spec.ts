import { beforeEach, describe, expect, it } from 'vitest';

import { mcpPairings } from '../storage/items';
import { installFakeChrome } from '../testing/fakeChrome';
import {
  addPairing,
  findPairing,
  hashToken,
  mintToken,
  renewPairing,
  revokePairing,
} from './pairings';

beforeEach(() => {
  installFakeChrome();
});

describe('MCP pairings', () => {
  it('mints distinct url-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 20 }, mintToken));

    expect(tokens.size).toBe(20);

    for (const token of tokens) expect(token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
  });

  it('stores only the token’s hash, and finds the pairing by its token', async () => {
    const { token, pairing } = await addPairing({ name: ' OpenCode ', client: 'opencode' }, 5);

    expect(pairing).toMatchObject({ name: 'OpenCode', client: 'opencode', created: 5 });
    expect(JSON.stringify(await mcpPairings.get())).not.toContain(token);
    expect((await mcpPairings.get())[0]?.hash).toBe(await hashToken(token));
    expect(await findPairing(token)).toEqual(pairing);
    expect(await findPairing('sk_other')).toBeUndefined();
    expect(await findPairing(undefined)).toBeUndefined();
  });

  it('makes the old token fail after New command, and deletes the hash on Revoke', async () => {
    const { token, pairing } = await addPairing({ name: 'Codex', client: 'codex' });
    const renewed = await renewPairing(pairing.id);

    expect(renewed).toBeDefined();
    expect(await findPairing(token)).toBeUndefined();
    expect(await findPairing(renewed)).toMatchObject({ id: pairing.id, name: 'Codex' });

    await revokePairing(pairing.id);

    expect(await findPairing(renewed)).toBeUndefined();
    expect(await mcpPairings.get()).toEqual([]);
    expect(await renewPairing(pairing.id)).toBeUndefined();
  });
});
