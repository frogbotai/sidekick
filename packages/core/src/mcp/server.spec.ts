import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { race } from '../browser/worker/abort';
import { runOf } from '../browser/worker/env';
import { blockedSites } from '../storage/items';
import { defineTool, type ToolDefinition, UNTRUSTED } from '../tool/tool';
import { flush, rawClient, setupWorker } from './fakes';
import { createMcpServer, KEEPALIVE } from './server';

const PAIRING = { id: 'pair-1', name: 'OpenCode' };

let waitEnv: Parameters<typeof runOf>[0] | undefined;

const wait = defineTool({
  id: 'wait',
  description: 'Waits in the run until it stops.',
  input: z.object({}),
  output: z.object({}),
  permission: 'read',
  execute: async (_input, ctx) => {
    if (!waitEnv) throw new Error('No env');

    const { signal } = runOf(waitEnv, ctx);

    await race(new Promise(() => undefined), signal);

    return { output: {} };
  },
});

async function connect(
  setup: ReturnType<typeof setupWorker>,
  { connectionID = 'mcp_a', client = PAIRING, tabId = 1 } = {},
) {
  const server = createMcpServer({
    tools: setup.tools,
    caller: setup.caller,
    connectionID,
    client,
    version: '0.9.0',
    run: () =>
      setup.worker.clientRun({
        connectionID,
        label: client.name,
        tabId,
        lastWindow: () => Promise.resolve(1),
      }),
  });

  const [peer, own] = InMemoryTransport.createLinkedPair();

  await server.connect(own);

  const mcp = rawClient(peer);

  await mcp.initialize('Claude Desktop');

  return { server, mcp };
}

function resultOf(message: unknown) {
  return (message as { result: Record<string, unknown> }).result;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  waitEnv = undefined;
});

describe('the MCP server', () => {
  it('lists the worker’s tools in id order, read-only hints on read tools only', async () => {
    const setup = setupWorker();
    const { mcp } = await connect(setup);
    const { tools } = resultOf(await mcp.request('tools/list')) as {
      tools: { name: string; inputSchema: { type: string }; annotations?: unknown }[];
    };

    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(setup.runtime.tools.map((tool) => tool.id).sort());
    expect(names).not.toContain('web_search');
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);

    const hinted = tools.filter((tool) => tool.annotations).map((tool) => tool.name);
    const reads = setup.runtime.tools.filter((tool) => tool.permission === 'read');

    expect(hinted).toEqual(reads.map((tool) => tool.id).sort());

    expect(tools.find((tool) => tool.name === 'snapshot')?.annotations).toEqual({
      readOnlyHint: true,
    });
  });

  it('returns a screenshot as an image after the untrusted note, and a ToolError as isError', async () => {
    const setup = setupWorker();
    const { mcp } = await connect(setup);

    const shot = resultOf(
      await mcp.request('tools/call', { name: 'screenshot', arguments: { tab_id: 1 } }),
    );

    const content = shot.content as { type: string; text?: string; data?: string }[];

    expect(shot.isError).toBeUndefined();
    expect(content[0]?.type).toBe('text');
    expect(content[1]).toEqual({ type: 'text', text: UNTRUSTED });
    expect(content[2]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });

    const failed = resultOf(
      await mcp.request('tools/call', { name: 'snapshot', arguments: { tab_id: 2 } }),
    );

    expect(failed).toEqual({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('isn’t in this task’s tab group') }],
    });
  });

  it('names the pairing as the client, whatever clientInfo and _meta say, and runs in its group', async () => {
    const setup = setupWorker();
    const scopes: unknown[] = [];
    const assert = setup.permission.assert;

    setup.permission.assert = (request, scope, signal) => {
      scopes.push(scope);

      return assert(request, scope, signal);
    };

    const { mcp } = await connect(setup);

    await mcp.request('tools/call', {
      name: 'snapshot',
      arguments: { tab_id: 1 },
      _meta: {
        client: { id: 'evil', name: 'Evil' },
        'io.modelcontextprotocol/clientInfo': { name: 'Evil' },
      },
    });

    expect(scopes).toEqual([
      expect.objectContaining({ sessionID: 'mcp_a', agent: 'build', client: PAIRING }),
    ]);

    const [run] = setup.runtime.env.runs.list();

    expect(run?.label).toBe('OpenCode');
    expect(setup.tabs.tabs.get(1)?.groupId).toBe(run?.groupId);
  });

  it('gives a blocked site’s denial as isError with the reason, and never asks', async () => {
    const setup = setupWorker();

    await blockedSites.set([{ site: 'example.com', created: 1 }]);

    const { mcp } = await connect(setup);

    const denied = resultOf(
      await mcp.request('tools/call', { name: 'click', arguments: { tab_id: 1, ref: 'f0e1' } }),
    );

    expect(denied).toEqual({
      isError: true,
      content: [
        { type: 'text', text: expect.stringContaining('The user blocked Sidekick on example.com') },
      ],
    });

    await blockedSites.set([]);
    setup.tabs.tabs.set(1, { ...setup.tabs.tabs.get(1)!, url: 'https://accounts.google.com/' });

    const sensitive = resultOf(
      await mcp.request('tools/call', { name: 'click', arguments: { tab_id: 1, ref: 'f0e1' } }),
    );

    expect(sensitive.isError).toBeUndefined();
    expect(setup.events.filter((event) => event.type === 'permission.asked')).toEqual([]);
  });

  it('stops only one client’s calls in flight when that client’s run stops', async () => {
    const setup = setupWorker({ tools: [wait] });

    waitEnv = setup.runtime.env;
    setup.tabs.createTab({ id: 5 });

    const a = await connect(setup, { connectionID: 'mcp_a' });
    const b = await connect(setup, {
      connectionID: 'mcp_b',
      client: { id: 'pair-2', name: 'Codex' },
      tabId: 5,
    });

    const first = a.mcp.request('tools/call', { name: 'wait', arguments: {} });
    const second = b.mcp.request('tools/call', { name: 'wait', arguments: {} });

    await flush();

    const runs = setup.runtime.env.runs.list();

    expect(runs.map((run) => run.label).sort()).toEqual(['Codex', 'OpenCode']);

    const own = runs.find((run) => run.label === 'OpenCode');

    setup.runtime.env.runs.stop(own?.id ?? '', 'user');

    expect(resultOf(await first)).toEqual({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('The run was stopped') }],
    });

    let settled = false;

    void second.then(() => (settled = true));
    await flush();

    expect(settled).toBe(false);
    expect(setup.runtime.env.runs.list().map((run) => run.label)).toEqual(['Codex']);
  });

  it('reports progress every 20 s during a call that has a progress token', async () => {
    const setup = setupWorker({ tools: [wait] });

    waitEnv = setup.runtime.env;

    const { mcp } = await connect(setup);

    void mcp.request('tools/call', { name: 'wait', arguments: {}, _meta: { progressToken: 'p1' } });
    await flush();
    await vi.advanceTimersByTimeAsync(KEEPALIVE * 2);

    expect(mcp.notifications).toEqual([
      expect.objectContaining({
        method: 'notifications/progress',
        params: { progressToken: 'p1', progress: 1 },
      }),
      expect.objectContaining({
        method: 'notifications/progress',
        params: { progressToken: 'p1', progress: 2 },
      }),
    ]);
  });

  it('tells the client when the tools change', async () => {
    const setup = setupWorker();
    const { mcp } = await connect(setup);
    const extra: ToolDefinition = { ...wait, id: 'later' };

    setup.tools.register('user', (draft) => draft.add(extra));
    await flush();

    expect(mcp.notifications).toContainEqual(
      expect.objectContaining({ method: 'notifications/tools/list_changed' }),
    );
  });
});
