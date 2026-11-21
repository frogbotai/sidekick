import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

import {
  blockedSites,
  mcpPairings,
  permissionGrants,
  permissionMode,
  theme,
  webSearchProvider,
} from '../storage/items';
import { rawClient, setupWorker } from './fakes';
import { createMcpServer } from './server';
import { connectionTools } from './tools';

function resultOf<T>(message: unknown) {
  return (message as { result: T }).result;
}

const PAIRING = { id: 'pair-1', name: 'OpenCode', client: 'opencode' as const };

async function connect(setup = setupWorker()) {
  const connectionID = 'mcp_a';
  const run = () =>
    setup.worker.clientRun({
      connectionID,
      label: PAIRING.name,
      tabId: 1,
      lastWindow: () => Promise.resolve(1),
    });

  const server = createMcpServer({
    tools: setup.tools,
    caller: setup.caller,
    connectionID,
    client: { id: PAIRING.id, name: PAIRING.name },
    version: '0.9.0',
    run,
    extra: connectionTools({
      connectionID,
      pairing: PAIRING,
      worker: setup.worker,
      version: '0.9.0',
      providers: () => ['exa', 'tavily'],
    }),
  });

  const [peer, own] = InMemoryTransport.createLinkedPair();

  await server.connect(own);

  const mcp = rawClient(peer);

  await mcp.initialize();

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = resultOf<{ isError?: boolean; content: { text: string }[] }>(
      await mcp.request('tools/call', { name, arguments: args }),
    );

    const text = result.content[0]?.text ?? '';

    return {
      isError: result.isError ?? false,
      text,
      value: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  return { setup, mcp, call, run };
}

describe('the status tool', () => {
  it('is listed beside the worker’s tools with a read-only hint', async () => {
    const { mcp, setup } = await connect();
    const result = resultOf<{ tools: { name: string; annotations?: unknown }[] }>(
      await mcp.request('tools/list'),
    );

    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(
      [...setup.runtime.tools.map((tool) => tool.id), 'settings', 'status'].sort(),
    );

    expect(result.tools.find((tool) => tool.name === 'status')?.annotations).toEqual({
      readOnlyHint: true,
    });

    expect(result.tools.find((tool) => tool.name === 'settings')?.annotations).toBeUndefined();
  });

  it('reports the pairing, version and mode, and no group before a browser call starts one', async () => {
    const { call, setup } = await connect();

    await permissionMode.set('plan');

    expect((await call('status')).value).toEqual({
      connected: true,
      pairingState: 'paired',
      pairing: { name: 'OpenCode', client: 'opencode' },
      extensionVersion: '0.9.0',
      group: null,
      permissionMode: 'plan',
    });

    expect(setup.runtime.env.runs.list()).toEqual([]);
  });

  it('lists the connection’s tab group and its tabs once a run starts', async () => {
    const { call, run } = await connect();

    await run();

    expect((await call('status')).value?.group).toEqual({
      title: 'OpenCode',
      tabs: [
        expect.objectContaining({ id: 1, title: expect.any(String), url: expect.any(String) }),
      ],
    });
  });
});

describe('the settings tool', () => {
  it('reads the safe settings and never grants, pairings, hubs or commands', async () => {
    const { call } = await connect();

    await permissionGrants.set([{ action: 'input', resource: '*', created: 1 }]);
    await mcpPairings.set([]);
    await blockedSites.set([{ site: 'bank.com', created: 1 }]);

    expect((await call('settings')).value).toEqual({
      theme: 'system',
      webSearchProvider: null,
      permissionMode: 'build',
      blockedSites: [{ site: 'bank.com', created: 1 }],
      agentModels: {},
      agentPrompts: {},
    });
  });

  it('changes theme and webSearchProvider, returning old and new values and a note', async () => {
    const { call } = await connect();

    const result = await call('settings', { set: { theme: 'dark', webSearchProvider: 'exa' } });

    expect(result.value).toEqual({
      changed: [
        { setting: 'theme', from: 'system', to: 'dark' },
        { setting: 'webSearchProvider', from: null, to: 'exa' },
      ],
      note: 'Tell the person what you changed.',
    });

    expect(await theme.get()).toBe('dark');
    expect(await webSearchProvider.get()).toBe('exa');

    await call('settings', { set: { webSearchProvider: false } });

    expect(await webSearchProvider.get()).toBe(false);
  });

  it('refuses the safety rails by name and changes nothing', async () => {
    const { call } = await connect();

    const result = await call('settings', { set: { permissionMode: 'auto', theme: 'dark' } });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('permissionMode: agents can’t change it');
    expect(result.text).toContain('Sidekick’s settings');
    expect(await permissionMode.get()).toBe('build');
    expect(await theme.get()).toBe('system');
  });

  it('refuses a __proto__ key beside an allowed one by name and changes nothing', async () => {
    const { call } = await connect();

    const result = await call(
      'settings',
      JSON.parse('{"set":{"__proto__":{"permissionMode":"auto"},"theme":"dark"}}') as Record<
        string,
        unknown
      >,
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('__proto__: unknown setting');
    expect(await theme.get()).toBe('system');
    expect(await permissionMode.get()).toBe('build');
  });

  it('lists every bad value at once and changes nothing', async () => {
    const { call } = await connect();

    const result = await call('settings', {
      set: { theme: 'neon', webSearchProvider: 'bing', permissionGrants: [], sound: true },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('theme: "neon" isn’t one of light | dark | system');

    expect(result.text).toContain(
      'webSearchProvider: "bing" isn’t one of exa | tavily | random | false',
    );

    expect(result.text).toContain('permissionGrants: agents can’t change it');
    expect(result.text).toContain('sound: unknown setting');
    expect(await theme.get()).toBe('system');
    expect(await webSearchProvider.get()).toBeUndefined();
  });

  it('asks the settings permission on a change, and none on a read', async () => {
    const setup = setupWorker();
    const asked: string[] = [];
    const assert = setup.permission.assert;

    setup.permission.assert = (request, scope, signal) => {
      asked.push(`${request.action} ${request.resource}`);

      return assert(request, scope, signal);
    };

    const { call } = await connect(setup);

    await call('settings');
    await call('settings', { set: { theme: 'light' } });

    expect(asked).toEqual(['settings sidekick']);
  });
});
