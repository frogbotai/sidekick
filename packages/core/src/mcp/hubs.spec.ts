import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { race } from '../browser/worker/abort';
import { type BrowserEnv, runOf } from '../browser/worker/env';
import { mcpHubs, mcpPairings } from '../storage/items';
import { defineTool } from '../tool/tool';
import { type FakeSocket, fakeSocket, flush, setupWorker } from './fakes';
import { createMcpHost, groupTitle, isLoopbackHub } from './hubs';
import { addPairing, renewPairing, revokePairing } from './pairings';
import { KEEPALIVE } from './server';

const HUB = 'ws://127.0.0.1:4100/secret-a';

const OTHER_HUB = 'ws://127.0.0.1:4200/secret-b';

const held: (() => void)[] = [];

let holdEnv: BrowserEnv | undefined;

const hold = defineTool({
  id: 'hold',
  description: 'Holds the call until the test releases it or the run stops.',
  input: z.object({}),
  output: z.object({}),
  permission: 'read',
  execute: async (_input, ctx) => {
    if (!holdEnv) throw new Error('No env');

    const { signal } = runOf(holdEnv, ctx);

    await race(ctx.permission.assert({ action: 'tabs', resource: '*' }), signal);
    await race(new Promise<void>((resolve) => void held.push(resolve)), signal);

    return { output: {} };
  },
});

function setup({ refuse = [] as string[] } = {}) {
  const worker = setupWorker({ tools: [hold] });

  holdEnv = worker.runtime.env;
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

function initialize(
  socket: FakeSocket,
  id = 1,
  clientInfo: { name: string; title?: string } = { name: 'x' },
) {
  socket.peer.send({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { ...clientInfo, version: '1' },
    },
  });

  socket.peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

function send(socket: FakeSocket, id: number, name: string, args: Record<string, unknown>) {
  socket.peer.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

async function reply(socket: FakeSocket, id: number) {
  await vi.waitFor(() => {
    if (!socket.peer.received.some((message) => (message as { id?: number }).id === id)) {
      throw new Error('no reply yet');
    }
  });

  return socket.peer.received.find((message) => (message as { id?: number }).id === id) as {
    result: { isError?: boolean; content: { text?: string }[] };
  };
}

async function call(socket: FakeSocket, id: number, name: string, args: Record<string, unknown>) {
  send(socket, id, name, args);

  return reply(socket, id);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  holdEnv = undefined;
  held.length = 0;
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

describe('a connection’s group title', () => {
  it.each([
    [
      'an Other pairing adds the client’s name',
      'other',
      'researcher',
      undefined,
      'FrogBot · researcher',
    ],
    [
      'a name that repeats the pairing’s, ignoring case, is dropped',
      'other',
      'frogbot',
      undefined,
      'FrogBot',
    ],
    ['a named app’s pairing keeps its name', 'opencode', 'opencode', undefined, 'FrogBot'],
    ['title beats name', 'other', 'researcher', 'Researcher agent', 'FrogBot · Researcher agent'],
    [
      'control characters and runs of whitespace collapse',
      'other',
      ' re\u0000search\n\t er ',
      undefined,
      'FrogBot · re search er',
    ],
    [
      'a long name is cut to 32 characters',
      'other',
      'a'.repeat(40),
      undefined,
      `FrogBot · ${'a'.repeat(31)}…`,
    ],
    ['an empty name gives the pairing’s name', 'other', ' \u0007 ', undefined, 'FrogBot'],
  ] as const)('%s', (_case, client, name, title, expected) => {
    expect(
      groupTitle({ name: 'FrogBot', client }, { name, ...(title === undefined ? {} : { title }) }),
    ).toBe(expected);
  });

  it('is the pairing’s name when the client sent no info', () => {
    expect(groupTitle({ name: 'FrogBot', client: 'other' }, undefined)).toBe('FrogBot');
  });

  it('titles an OpenCode pairing whose client sends opencode just OpenCode', async () => {
    const { host, sockets, runtime } = setup();
    const { token } = await addPairing({ name: 'OpenCode', client: 'opencode' });

    await host.connect({ hub: HUB, token });
    initialize(sockets[0], 1, { name: 'opencode' });
    await call(sockets[0], 2, 'tabs_list', {});

    expect(runtime.env.runs.list().map((run) => run.label)).toEqual(['OpenCode']);
  });

  it('gives two agents on one Other token a group each, named by their client', async () => {
    const { host, sockets, runtime } = setup();
    const { token } = await addPairing({ name: 'FrogBot', client: 'other' });

    await host.connect({ hub: HUB, token });
    await host.connect({ hub: OTHER_HUB, token });

    initialize(sockets[0], 1, { name: 'researcher' });
    initialize(sockets[1], 1, { name: 'support' });
    await call(sockets[0], 2, 'tabs_list', {});
    await call(sockets[1], 2, 'tabs_list', {});

    const runs = runtime.env.runs.list();

    expect(runs.map((run) => run.label)).toEqual(['FrogBot · researcher', 'FrogBot · support']);
    expect(new Set(runs.map((run) => run.groupId)).size).toBe(2);
  });

  it('stops only one agent’s call, keeps its title on the next run and the pairing in the scope', async () => {
    const { host, sockets, runtime, permission } = setup();
    const { token, pairing } = await addPairing({ name: 'FrogBot', client: 'other' });
    const scopes: unknown[] = [];
    const { assert } = permission;

    permission.assert = (request, scope, signal) => {
      scopes.push(scope);

      return assert(request, scope, signal);
    };

    await host.connect({ hub: HUB, token });
    await host.connect({ hub: OTHER_HUB, token });

    const [researcher, support] = sockets;

    initialize(researcher, 1, { name: 'researcher' });
    initialize(support, 1, { name: 'support' });
    send(researcher, 2, 'hold', {});
    await vi.waitFor(() => expect(runtime.env.runs.list()).toHaveLength(1));
    send(support, 2, 'hold', {});
    await vi.waitFor(() => expect(held).toHaveLength(2));

    const first = runtime.env.runs.list().find((run) => run.label === 'FrogBot · researcher');

    runtime.env.runs.stop(first?.id ?? '', 'user');

    expect((await reply(researcher, 2)).result).toEqual({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('The run was stopped') }],
    });

    for (const release of held) release();

    expect((await reply(support, 2)).result.isError).toBeUndefined();

    await call(researcher, 3, 'tabs_list', {});

    const next = runtime.env.runs.list().find((run) => run.label === 'FrogBot · researcher');

    expect(next?.id).not.toBe(first?.id);
    expect(scopes.length).toBeGreaterThanOrEqual(3);

    for (const scope of scopes) {
      expect(scope).toMatchObject({ client: { id: pairing.id, name: 'FrogBot' } });
    }
  });
});
