import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { fakeCdp, fakePage, fakeTabs, type Log } from '../browser/worker/fakes';
import { OUTSIDE_TAB, START_TAB } from '../browser/worker/harness';
import { createBrowserRuntime } from '../browser/worker/runtime';
import { createBrowserWorker } from '../browser/worker/serve';
import type { Page } from '../browser/worker/types';
import { createForms } from '../form';
import {
  createPermissionEngine,
  type PermissionEngine,
  type PermissionScope,
} from '../permission/engine';
import { BUILTIN_MODES, type PermissionMode } from '../permission/modes';
import { sidekickProtocol } from '../protocol';
import { searchProviders } from '../registry';
import { createRegistry } from '../registry/registry';
import { connectWorker, MIN_BACKOFF } from '../rpc/client';
import { CONNECTED } from '../rpc/define';
import { serve, type Server } from '../rpc/server';
import { webSearch } from '../search/service';
import { webSearchTool } from '../search/tool';
import { webSearchProvider } from '../storage';
import { installFakeChrome } from '../testing/fakeChrome';
import { type FakeRuntime, installFakeRuntime } from '../testing/fakeRuntime';
import { createToolBridge } from './bridge';
import { NOT_CONNECTED, registerWorkerTools, WORKER_SOURCE, workerPermission } from './proxy';
import {
  defineTool,
  type PermissionRequest,
  type ToolContext,
  type ToolDefinition,
  ToolError,
} from './tool';

let fake: FakeRuntime;

async function flush() {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
}

function context(callID = 'call-1'): ToolContext & { controller: AbortController } {
  const controller = new AbortController();

  return {
    controller,
    signal: controller.signal,
    session: { id: 'ses-1' },
    messageID: 'msg-1',
    callID,
    agent: 'build',
    permission: { assert: () => Promise.resolve() },
  };
}

const cancelled: string[] = [];

const stale = defineTool({
  id: 'stale',
  description: 'Always stale.',
  input: z.object({ ref: z.string() }),
  output: z.object({}),
  permission: 'input',
  execute: ({ ref }) => {
    throw new ToolError('stale_ref', `${ref} is gone. Take a new snapshot.`, {
      ref,
      refs: ['f0e1'],
    });
  },
});

const slow = defineTool({
  id: 'slow',
  description: 'Waits until cancelled.',
  input: z.object({}),
  output: z.object({}),
  permission: 'read',
  execute: (_, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        cancelled.push(ctx.callID);
        reject(new ToolError('cancelled', 'Cancelled'));
      });
    }),
});

type BridgePermission = Pick<PermissionEngine, 'assert' | 'reply' | 'list' | 'cancel'>;

function realEngine(emit: Server<typeof sidekickProtocol>['emit']) {
  const agents = createRegistry<AgentInfo>('agents');
  const modes = createRegistry<PermissionMode>('permissionModes');

  agents.register('builtin', (draft) => {
    for (const agent of BUILTIN_AGENTS) draft.add(agent);
  });

  modes.register('builtin', (draft) => {
    for (const mode of BUILTIN_MODES) draft.add(mode);
  });

  return createPermissionEngine({ agents, modes, emit });
}

interface Boot {
  asserts: { request: PermissionRequest; scope: PermissionScope }[];
  runs: ReturnType<typeof createBrowserRuntime>['env']['runs'];
}

function boot(
  tabs = fakeTabs([], [START_TAB, OUTSIDE_TAB]),
  extra: ToolDefinition[] = [slow, stale],
  page: Partial<Page> = {},
  engine?: (emit: Server<typeof sidekickProtocol>['emit']) => BridgePermission,
): Boot {
  const log: Log = [];
  const runtime = createBrowserRuntime({
    cdp: fakeCdp(log),
    page: fakePage(log, page),
    tabs,
    mac: false,
  });

  const browser = createBrowserWorker(runtime);
  const registry = createRegistry<ToolDefinition>('tools');
  const asserts: Boot['asserts'] = [];

  registry.register('builtin', (draft) => {
    for (const tool of [...runtime.tools, ...extra]) draft.add(tool);
  });

  let server: Server<typeof sidekickProtocol> | undefined;

  const bridge = createToolBridge({
    tools: registry,
    permission: engine?.((type, data) => server?.emit(type, data)) ?? {
      assert: (request, scope) => {
        asserts.push({ request, scope });

        return Promise.resolve();
      },
      reply: () => Promise.resolve(),
      list: () => [],
      cancel: () => undefined,
    },
    run: browser.sessionRun,
  });

  server = serve(
    sidekickProtocol,
    {
      'tab.ping': () => Promise.reject(new Error('unused')),
      'mcp.connect': () => Promise.reject(new Error('unused')),
      'mcp.disconnect': () => Promise.reject(new Error('unused')),
      ...browser.handlers,
      ...bridge,
    },
    { bootId: crypto.randomUUID() },
  );

  browser.connect(server);

  return { asserts, runs: runtime.env.runs };
}

async function panel(windowId = 1) {
  const client = connectWorker(sidekickProtocol);
  const registry = createRegistry<ToolDefinition>('tools');

  await flush();
  await registerWorkerTools(registry, client, { windowId });

  const tool = (id: string) => {
    const found = registry.get(id);

    if (!found) throw new Error(`No proxy for ${id}`);

    return found;
  };

  return { client, registry, tool };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  if (!(error instanceof ToolError)) throw new Error(`Expected a ToolError, got ${String(error)}`);

  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeChrome();
  fake = installFakeRuntime();
  cancelled.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the worker tool bridge', () => {
  it('registers a proxy per worker tool under the source worker', async () => {
    boot();

    const { registry } = await panel();

    expect(registry.list().map(({ id }) => id)).toEqual(
      expect.arrayContaining(['tabs_list', 'snapshot', 'slow']),
    );

    expect(registry.errors()).toEqual([]);
    expect(WORKER_SOURCE).toBe('worker');
  });

  it('keeps a ToolError’s stale_ref code and detail through the proxy', async () => {
    boot();

    const { tool } = await panel();
    const error = await failure(tool('stale').execute({ ref: 'f0e9' }, context()));

    expect(error.code).toBe('stale_ref');
    expect(error.message).toBe('f0e9 is gone. Take a new snapshot.');
    expect(error.detail).toEqual({ ref: 'f0e9', refs: ['f0e1'] });
  });

  it('waits past the 30 s RPC timeout, and abort sends tool.cancel', async () => {
    boot();

    const { tool } = await panel();
    const ctx = context('call-slow');
    const call = failure(tool('slow').execute({}, ctx));

    await vi.advanceTimersByTimeAsync(31_000);

    expect(cancelled).toEqual([]);

    ctx.controller.abort();
    await flush();

    const sent = fake.clientPorts[0]?.sent ?? [];

    expect(sent).toContainEqual(
      expect.objectContaining({ method: 'tool.cancel', input: { callID: 'call-slow' } }),
    );

    expect(cancelled).toEqual(['call-slow']);
    expect((await call).code).toBe('cancelled');
  });

  it('starts one run per chat from its window’s active tab, and hides it between messages', async () => {
    const { runs } = boot();
    const { tool, client } = await panel();

    await tool('tabs_list').execute({}, context('c1'));
    await tool('tabs_list').execute({}, context('c2'));

    expect(runs.list()).toHaveLength(1);
    expect(runs.list()[0]).toMatchObject({ sessionID: 'ses-1', label: 'Sidekick' });

    await client.call('run.end', { sessionID: 'ses-1', close: false });

    expect(runs.list()).toHaveLength(1);

    await client.call('run.end', { sessionID: 'ses-1', close: true });

    expect(runs.list()).toHaveLength(0);
  });

  it('fails a call not_connected when the worker restarts, and the next call starts a new run', async () => {
    const tabs = fakeTabs([], [START_TAB, OUTSIDE_TAB]);
    const first = boot(tabs);
    const { tool } = await panel();

    await tool('tabs_list').execute({}, context('c1'));

    const [before] = first.runs.list();
    const pending = failure(tool('slow').execute({}, context('c2')));

    await flush();
    fake.stopWorker();

    const error = await pending;

    expect(error.code).toBe('not_connected');
    expect(error.message).toBe(NOT_CONNECTED);

    const second = boot(tabs);

    await vi.advanceTimersByTimeAsync(MIN_BACKOFF);
    await flush();
    await tool('tabs_list').execute({}, context('c3'));

    const [after] = second.runs.list();

    expect(after?.id).toBeDefined();
    expect(after?.id).not.toBe(before?.id);
    expect(after?.sessionID).toBe('ses-1');
  });

  it('fails a real worker tool stopped when the user stops its run, naming the chat', async () => {
    const { runs } = boot(undefined, undefined, { snapshot: () => new Promise(() => undefined) });
    const { tool, client } = await panel();
    const stopped: unknown[] = [];

    client.on('run.stopped', (event) => stopped.push(event));
    await tool('tabs_list').execute({}, context('c1'));

    const pending = failure(tool('snapshot').execute({ tab_id: START_TAB.id }, context('c2')));

    await flush();

    const [run] = runs.list();

    await client.call('run.stop', { runId: run?.id ?? '' });

    expect((await pending).code).toBe('stopped');

    await flush();

    expect(stopped).toEqual([{ runId: run?.id, reason: 'user', sessionID: 'ses-1' }]);
  });

  it('cancels a real worker tool when the panel aborts it, keeping the run', async () => {
    const { runs } = boot(undefined, undefined, { snapshot: () => new Promise(() => undefined) });
    const { tool } = await panel();
    const ctx = context('c-snap');
    const pending = failure(tool('snapshot').execute({ tab_id: START_TAB.id }, ctx));

    await flush();
    ctx.controller.abort();

    expect((await pending).code).toBe('stopped');
    expect(runs.list()).toHaveLength(1);

    await tool('tabs_list').execute({}, context('c-next'));
  });

  it('lists the new worker’s tools after a restart, on its connected event', async () => {
    const tabs = fakeTabs([], [START_TAB, OUTSIDE_TAB]);

    boot(tabs, [slow]);

    const { client } = await panel();
    const registry = createRegistry<ToolDefinition>('tools');
    let unregister = await registerWorkerTools(registry, client, { windowId: 1 });

    expect(registry.get('slow')).toBeDefined();

    client.on(CONNECTED, () => {
      void registerWorkerTools(registry, client, { windowId: 1 }).then((next) => {
        unregister();
        unregister = next;
      });
    });

    fake.stopWorker();
    boot(tabs, [stale]);
    await vi.advanceTimersByTimeAsync(MIN_BACKOFF);
    await flush();

    const relisted = registry.get('stale');

    expect(registry.get('slow')).toBeUndefined();
    expect(relisted).toBeDefined();

    expect(
      (await failure(relisted?.execute({ ref: 'f0e2' }, context()) ?? Promise.resolve())).code,
    ).toBe('stale_ref');
  });

  it('sends the panel’s web_search assert to the worker’s seam', async () => {
    const { asserts } = boot();
    const { client } = await panel();
    const search = vi.fn(() => Promise.resolve([{ url: 'https://a.example/', title: 'A' }]));
    const dispose = searchProviders.register('test', (draft) =>
      draft.add({ id: 'frogbot', name: 'FrogBot', search }),
    );

    await webSearch.select('frogbot');
    await webSearchProvider.get();

    const permission = workerPermission(client);
    const ctx = context('call-search');
    const scope = { sessionID: 'ses-1', messageID: 'msg-1', callID: 'call-search', agent: 'build' };

    await webSearchTool(createForms()).execute(
      { query: 'chrome mv3' },
      { ...ctx, permission: { assert: (request) => permission.assert(request, scope) } },
    );

    expect(asserts).toEqual([{ request: { action: 'websearch', resource: 'chrome mv3' }, scope }]);

    dispose();
  });

  it('drops a client a page puts in its scope, so only the MCP host can skip asks', async () => {
    const { asserts } = boot();
    const { client } = await panel();
    const scope = { sessionID: 'ses-1', messageID: 'msg-1', callID: 'call-x', agent: 'build' };

    await workerPermission(client).assert(
      { action: 'input', resource: 'https://example.com' },
      { ...scope, client: { id: 'pair-1', name: 'OpenCode' } },
    );

    expect(asserts).toEqual([
      { request: { action: 'input', resource: 'https://example.com' }, scope },
    ]);
  });

  it('waits past 31 s on a panel assert’s ask, and tool.cancel drops it', async () => {
    boot(undefined, undefined, undefined, realEngine);

    const { client } = await panel();
    const asked: unknown[] = [];

    client.on('permission.asked', (ask) => asked.push(ask));

    const permission = workerPermission(client);
    const controller = new AbortController();
    const scope = { sessionID: 'ses-1', messageID: 'msg-1', callID: 'call-ask', agent: 'build' };

    const call = failure(
      permission.assert(
        { action: 'input', resource: 'https://github.com' },
        scope,
        controller.signal,
      ),
    );

    await vi.advanceTimersByTimeAsync(31_000);
    await flush();

    expect(asked).toEqual([expect.objectContaining({ callID: 'call-ask', site: 'github.com' })]);
    expect(await client.call('permission.list', { sessionID: 'ses-1' })).toHaveLength(1);

    controller.abort();
    await flush();

    expect((await call).code).toBe('cancelled');
    expect(await client.call('permission.list', {})).toEqual([]);
  });

  it('answers a worker tool’s ask over permission.reply, and fails navigated if the tab moved meanwhile', async () => {
    const tabs = fakeTabs([], [START_TAB, OUTSIDE_TAB]);

    boot(tabs, undefined, undefined, realEngine);

    const { client, tool } = await panel();
    const asked: { id: string }[] = [];

    client.on('permission.asked', (ask) => asked.push(ask));
    await tool('tabs_list').execute({}, context('c1'));

    const call = tool('click').execute({ tab_id: START_TAB.id, ref: 'f0e1' }, context('c2'));

    await flush();

    const moved = tabs.tabs.get(START_TAB.id);

    if (moved) moved.url = 'https://elsewhere.test/';

    await client.call('permission.reply', { id: asked[0]?.id ?? '', reply: 'once' });

    expect((await failure(call)).code).toBe('navigated');
  });
});
