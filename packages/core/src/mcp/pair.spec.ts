import { beforeEach, describe, expect, it } from 'vitest';

import { mcpPairings } from '../storage/items';
import { installFakeChrome } from '../testing/fakeChrome';
import { type FakeSocket, fakeSocket } from './fakes';
import { computerName, pairHandlers } from './pair';
import { addPairing, findPairing } from './pairings';

const HUB = 'ws://127.0.0.1:4100/secret';

function setup() {
  const sockets: FakeSocket[] = [];

  const handlers = pairHandlers((url) => {
    const socket = fakeSocket(url);

    sockets.push(socket);

    return socket;
  });

  return { handlers, sockets };
}

async function until(check: () => boolean) {
  for (let tick = 0; tick < 500 && !check(); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  installFakeChrome();
});

describe('pairing from an install command', () => {
  it('names the pairing after the computer, sends its key to the hub and keeps it on ok', async () => {
    const { handlers, sockets } = setup();
    const result = handlers['mcp.pair']({ hub: HUB, pair: 'req-1', computer: 'laptop' });

    await until(() => sockets.length > 0);

    const [socket] = sockets;

    expect(new URL(socket?.url ?? '').searchParams.get('pair')).toBe('req-1');

    socket?.open();
    await until(() => (socket?.peer.received.length ?? 0) > 0);

    const [message] = (socket?.peer.received ?? []) as {
      type: string;
      key: string;
      pairingID: string;
    }[];

    expect(message?.type).toBe('sidekick/paired');

    socket?.peer.send({ type: 'sidekick/ok' });

    expect(await result).toEqual({ paired: true, name: 'laptop' });

    expect(await findPairing(message?.key)).toMatchObject({
      id: message?.pairingID,
      name: 'laptop',
      client: 'other',
    });
  });

  it('revokes the new pairing when the hub refuses, or closes before acknowledging', async () => {
    const { handlers, sockets } = setup();
    const refused = handlers['mcp.pair']({ hub: HUB, pair: 'used', computer: 'laptop' });

    await until(() => sockets.length > 0);
    sockets[0]?.fail();

    expect(await refused).toEqual({ paired: false, reason: 'unreachable' });

    const dropped = handlers['mcp.pair']({ hub: HUB, pair: 'req', computer: 'laptop' });

    await until(() => sockets.length > 1);
    sockets[1]?.open();
    await until(() => (sockets[1]?.peer.received.length ?? 0) > 0);
    sockets[1]?.peer.close();

    expect(await dropped).toEqual({ paired: false, reason: 'unreachable' });
    expect(await mcpPairings.get()).toEqual([]);
  });

  it('dials nothing off this machine', async () => {
    const { handlers, sockets } = setup();

    expect(
      await handlers['mcp.pair']({ hub: 'ws://example.com/x', pair: 'p', computer: 'c' }),
    ).toEqual({ paired: false, reason: 'not_loopback' });

    expect(await handlers['mcp.unpair']({ hub: 'ws://example.com/x', token: 'sk_x' })).toEqual({
      unpaired: false,
      reason: 'not_loopback',
    });

    expect(sockets).toEqual([]);
    expect(await mcpPairings.get()).toEqual([]);
  });

  it('keeps a computer’s name short and printable', () => {
    expect(computerName(' laptop\u0007\n')).toBe('laptop');
    expect(computerName('')).toBe('This computer');
    expect([...computerName('x'.repeat(100))]).toHaveLength(64);
  });
});

describe('unpairing from uninstall', () => {
  it('revokes the key’s pairing once the hub holding the key answers, and tells it', async () => {
    const { handlers, sockets } = setup();
    const { pairing, token } = await addPairing({ name: 'laptop', client: 'other' });
    const result = handlers['mcp.unpair']({ hub: HUB, token });

    await until(() => sockets.length > 0);

    const [socket] = sockets;

    expect(new URL(socket?.url ?? '').searchParams.get('token')).toBe(token);
    expect(await mcpPairings.get()).toEqual([pairing]);

    socket?.open();
    await until(() => (socket?.peer.received.length ?? 0) > 0);

    expect(socket?.peer.received).toEqual([{ type: 'sidekick/unpaired' }]);

    socket?.peer.send({ type: 'sidekick/ok' });

    expect(await result).toEqual({ unpaired: true });
    expect(await mcpPairings.get()).toEqual([]);
  });

  it('revokes nothing when the hub can’t be reached', async () => {
    const { handlers, sockets } = setup();
    const { pairing, token } = await addPairing({ name: 'laptop', client: 'other' });
    const result = handlers['mcp.unpair']({ hub: HUB, token });

    await until(() => sockets.length > 0);
    sockets[0]?.fail();

    expect(await result).toEqual({ unpaired: false, reason: 'unreachable' });
    expect(await mcpPairings.get()).toEqual([pairing]);
  });
});
