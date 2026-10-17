import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mcpHubs, mcpPairings } from '../storage/items';
import { type FakeSocket, fakeSocket, flush, setupWorker } from './fakes';
import { createMcpHost, isLoopbackHub } from './hubs';
import { addPairing, renewPairing, revokePairing } from './pairings';
import { KEEPALIVE } from './server';

const HUB = 'ws://127.0.0.1:4100/secret-a';

const OTHER_HUB = 'ws://127.0.0.1:4200/secret-b';

function setup({ refuse = [] as string[] } = {}) {
  const worker = setupWorker();
  const sockets: FakeSocket[] = [];

  const host = createMcpHost({
    tools: worker.tools,
    caller: worker.caller,
    worker: worker.worker,
    lastWindow: () => Promise.resolve(1),
    version: '0.9.0',
    dial: (url) => {
      const socket = fakeSocket(url);

      sockets.push(socket);

      queueMicrotask(() =>
        refuse.some((hub) => url.startsWith(hub)) ? socket.fail() : socket.open(),
      );

      return socket;
    },
  });

  return { ...worker, host, sockets };
}

function initialize(socket: FakeSocket, id = 1) {
  socket.peer.send({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    },
  });

  socket.peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

async function call(socket: FakeSocket, id: number, name: string, args: Record<string, unknown>) {
  socket.peer.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  await vi.waitFor(() => {
    if (!socket.peer.received.some((message) => (message as { id?: number }).id === id)) {
      throw new Error('no reply yet');
    }
  });

  return socket.peer.received.find((message) => (message as { id?: number }).id === id) as {
    result: { isError?: boolean; content: { text?: string }[] };
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the MCP host', () => {
  it('takes only ws: hubs on this machine', () => {
    expect(isLoopbackHub(HUB)).toBe(true);
    expect(isLoopbackHub('ws://localhost:9/x')).toBe(true);
    expect(isLoopbackHub('ws://[::1]:9/x')).toBe(true);
    expect(isLoopbackHub('ws://example.com/x')).toBe(false);
    expect(isLoopbackHub('wss://127.0.0.1/x')).toBe(false);
    expect(isLoopbackHub('http://127.0.0.1/x')).toBe(false);
    expect(isLoopbackHub('not a url')).toBe(false);
  });

  it('dials nothing for an unknown token or a hub off this machine', async () => {
    const { host, sockets } = setup();
    const { token } = await addPairing({ name: 'OpenCode', client: 'opencode' });

    expect(await host.connect({ hub: HUB, token: 'sk_unknown' })).toEqual({
      connected: false,
      reason: 'unknown_token',
    });

    expect(await host.connect({ hub: 'ws://example.com/secret', token })).toEqual({
      connected: false,
      reason: 'not_loopback',
    });

    expect(sockets).toEqual([]);
  });

  it('dials the hub with the token, keeps it in storage.session and adopts the connect tab', async () => {
    const { host, sockets, runtime, tabs } = setup();
    const { token, pairing } = await addPairing({ name: 'OpenCode', client: 'opencode' });

    expect(await host.connect({ hub: HUB, token, tabId: 2 })).toEqual({
      connected: true,
      name: 'OpenCode',
      adopted: true,
    });

    expect(new URL(sockets[0]?.url ?? '').searchParams.get('token')).toBe(token);
    expect(await mcpHubs.get()).toEqual([{ hub: HUB, token, pairingID: pairing.id }]);

    const socket = sockets[0];

    initialize(socket);
    await call(socket, 2, 'tabs_list', {});

    const [run] = runtime.env.runs.list();

    expect(run?.label).toBe('OpenCode');
    expect(tabs.tabs.get(2)?.groupId).toBe(run?.groupId);
  });

  it('gives two helpers on one token one pairing, with a run each', async () => {
    const { host, sockets, runtime } = setup();
    const { token } = await addPairing({ name: 'OpenCode', client: 'opencode' });

    await host.connect({ hub: HUB, token });
    await host.connect({ hub: OTHER_HUB, token });

    for (const [index, socket] of sockets.entries()) {
      initialize(socket);
      await call(socket, 2 + index, 'tabs_list', {});
    }

    const runs = runtime.env.runs.list();

    expect(runs.map((run) => run.label)).toEqual(['OpenCode', 'OpenCode']);
    expect(new Set(runs.map((run) => run.groupId)).size).toBe(2);
  });

  it('dials a hub once when the connect page and a redial race, and opens a later run in a new tab', async () => {
    const { host, sockets, runtime, tabs } = setup();
    const { token } = await addPairing({ name: 'Codex', client: 'codex' });

    await Promise.all([
      host.connect({ hub: HUB, token }),
      host.connect({ hub: HUB, token, tabId: 2 }),
    ]);

    expect(sockets).toHaveLength(1);

    const socket = sockets[0];

    initialize(socket);
    await call(socket, 2, 'tabs_list', {});

    const [first] = runtime.env.runs.list();

    expect(tabs.tabs.get(2)?.groupId).toBe(first?.groupId);

    runtime.env.runs.stop(first?.id ?? '', 'user');
    await call(socket, 3, 'tabs_list', {});

    const [second] = runtime.env.runs.list();
    const opened = [...tabs.tabs.values()].find((tab) => tab.groupId === second?.groupId);

    expect(second?.id).not.toBe(first?.id);
    expect(opened?.id).toBeGreaterThanOrEqual(1000);
  });

  it('pings the helper every 20 s', async () => {
    const { host, sockets } = setup();
    const { token } = await addPairing({ name: 'OpenCode', client: 'opencode' });

    await host.connect({ hub: HUB, token });
    initialize(sockets[0]);
    await flush();
    await vi.advanceTimersByTimeAsync(KEEPALIVE);

    expect(sockets[0]?.peer.received).toContainEqual(expect.objectContaining({ method: 'ping' }));
  });

  it('redials every hub in storage.session after a restart, and forgets the ones that are gone', async () => {
    const before = setup();
    const opencode = await addPairing({ name: 'OpenCode', client: 'opencode' });
    const codex = await addPairing({ name: 'Codex', client: 'codex' });

    await before.host.connect({ hub: HUB, token: opencode.token });
    await before.host.connect({ hub: OTHER_HUB, token: codex.token });

    const kept = await mcpHubs.get();
    const pairings = await mcpPairings.get();
    const after = setup({ refuse: [OTHER_HUB] });

    await mcpPairings.set(pairings);
    await mcpHubs.set(kept);
    await after.host.restore();

    expect(after.sockets.map((socket) => new URL(socket.url).pathname).sort()).toEqual([
      '/secret-a',
      '/secret-b',
    ]);

    expect((await mcpHubs.get()).map((entry) => entry.hub)).toEqual([HUB]);
  });

  it('closes a pairing’s sockets on Disconnect, Revoke and New command, and drops their hubs', async () => {
    const { host, sockets } = setup();
    const opencode = await addPairing({ name: 'OpenCode', client: 'opencode' });
    const codex = await addPairing({ name: 'Codex', client: 'codex' });

    await host.connect({ hub: HUB, token: opencode.token });
    await host.connect({ hub: OTHER_HUB, token: codex.token });

    await host.handlers['mcp.disconnect']({ pairingID: opencode.pairing.id });
    await flush();

    expect(sockets.map((socket) => socket.readyState)).toEqual([3, 1]);
    expect((await mcpHubs.get()).map((entry) => entry.hub)).toEqual([OTHER_HUB]);

    await renewPairing(codex.pairing.id);
    await flush();

    expect(sockets[1]?.readyState).toBe(3);

    expect(await host.connect({ hub: OTHER_HUB, token: codex.token })).toMatchObject({
      reason: 'unknown_token',
    });

    await host.connect({ hub: HUB, token: opencode.token });
    await revokePairing(opencode.pairing.id);
    await flush();

    expect(sockets[2]?.readyState).toBe(3);
    expect(await mcpHubs.get()).toEqual([]);
  });

  it('ends a connection’s run when its socket closes', async () => {
    const { host, sockets, runtime } = setup();
    const { token } = await addPairing({ name: 'OpenCode', client: 'opencode' });

    await host.connect({ hub: HUB, token, tabId: 2 });
    initialize(sockets[0]);
    await call(sockets[0], 2, 'tabs_list', {});

    expect(runtime.env.runs.list()).toHaveLength(1);

    sockets[0]?.peer.close();
    await flush();

    expect(runtime.env.runs.list()).toEqual([]);
    expect(await mcpHubs.get()).toEqual([]);
  });
});
