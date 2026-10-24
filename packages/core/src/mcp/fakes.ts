import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { fakeCdp, fakePage, fakeTabs, type Log } from '../browser/worker/fakes';
import { OUTSIDE_TAB, START_TAB } from '../browser/worker/harness';
import { createBrowserRuntime } from '../browser/worker/runtime';
import { createBrowserWorker } from '../browser/worker/serve';
import type { Page } from '../browser/worker/types';
import { createPermissionEngine } from '../permission/engine';
import { BUILTIN_MODES, type PermissionMode } from '../permission/modes';
import { createRegistry } from '../registry/registry';
import { installFakeChrome } from '../testing/fakeChrome';
import { createToolCaller } from '../tool/bridge';
import { createKeyedLock } from '../tool/lock';
import type { ToolDefinition } from '../tool/tool';
import type { Socket } from './transport';

/** One end of an in-memory socket pair; `peer` is the helper's end. */
export interface FakeSocket extends Socket {
  url: string;
  peer: { send: (message: unknown) => void; received: unknown[]; close: () => void };
  open: () => void;
  fail: () => void;
}

type Listener = (event: { data?: unknown }) => void;

/** A socket that opens when the test says so, and records what the worker sends. */
export function fakeSocket(url: string): FakeSocket {
  const listeners = new Map<string, Set<{ listener: Listener; once: boolean }>>();
  const received: unknown[] = [];

  const fire = (type: string, event: { data?: unknown } = {}) => {
    for (const entry of [...(listeners.get(type) ?? [])]) {
      if (entry.once) listeners.get(type)?.delete(entry);

      entry.listener(event);
    }
  };

  const socket: FakeSocket = {
    url,
    readyState: 0,
    send: (data: string) => void received.push(JSON.parse(data)),
    close: () => {
      if (socket.readyState === 3) return;

      Object.assign(socket, { readyState: 3 });
      fire('close');
    },
    addEventListener: ((type: string, listener: Listener, options?: { once?: boolean }) => {
      const set = listeners.get(type) ?? new Set();

      set.add({ listener, once: options?.once ?? false });
      listeners.set(type, set);
    }) as Socket['addEventListener'],
    peer: {
      send: (message) => fire('message', { data: JSON.stringify(message) }),
      received,
      close: () => socket.close(),
    },
    open: () => {
      Object.assign(socket, { readyState: 1 });
      fire('open');
    },
    fail: () => {
      fire('error');
      socket.close();
    },
  };

  return socket;
}

export async function flush() {
  for (let tick = 0; tick < 50; tick++) await Promise.resolve();
}

/** A raw JSON-RPC client over the other end of a transport, as an MCP client sends it. */
export function rawClient(transport: Transport) {
  const replies = new Map<string | number, (message: JSONRPCMessage) => void>();
  const notifications: JSONRPCMessage[] = [];
  let next = 1;

  transport.onmessage = (message) => {
    const id = 'id' in message ? message.id : undefined;
    const reply = id === undefined ? undefined : replies.get(id);

    if (reply && ('result' in message || 'error' in message)) reply(message);
    else notifications.push(message);
  };

  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = next++;

    return new Promise<JSONRPCMessage>((resolve) => {
      replies.set(id, resolve);
      void transport.send({ jsonrpc: '2.0', id, method, params });
    });
  };

  return {
    notifications,
    request,
    notify: (method: string) => transport.send({ jsonrpc: '2.0', method }),
    initialize: async (name = 'Some client') => {
      await transport.start();

      const reply = await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name, version: '1.0.0' },
      });

      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      return reply;
    },
  };
}

/** The worker side the MCP host needs: browser runtime, runs, a real permission engine and the tools registry. */
export function setupWorker({
  page: overrides,
  agents: extra = [],
  tools: more = [],
}: { page?: Partial<Page>; agents?: AgentInfo[]; tools?: ToolDefinition[] } = {}) {
  const storage = installFakeChrome();
  const log: Log = [];
  const tabs = fakeTabs(log, [START_TAB, OUTSIDE_TAB]);
  const runtime = createBrowserRuntime({
    cdp: fakeCdp(log),
    page: fakePage(log, overrides),
    tabs,
    mac: false,
  });

  const worker = createBrowserWorker(runtime);
  const agents = createRegistry<AgentInfo>('agents');
  const modes = createRegistry<PermissionMode>('permissionModes');
  const events: { type: string; data: unknown }[] = [];
  const tools = createRegistry<ToolDefinition>('tools');

  agents.register('builtin', (draft) => {
    for (const agent of BUILTIN_AGENTS) draft.add(agent);
  });

  if (extra.length > 0) {
    agents.register('test', (draft) => {
      for (const agent of extra) draft.add(agent);
    });
  }

  modes.register('builtin', (draft) => {
    for (const mode of BUILTIN_MODES) draft.add(mode);
  });

  tools.register('builtin', (draft) => {
    for (const tool of [...runtime.tools, ...more]) draft.add(tool);
  });

  const permission = createPermissionEngine({
    agents,
    modes,
    emit: (type, data) => void events.push({ type, data }),
  });

  const locks = createKeyedLock();
  const caller = createToolCaller({ tools, permission, locks });

  return { storage, log, tabs, runtime, worker, tools, permission, caller, locks, events };
}
