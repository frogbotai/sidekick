import type { BrowserWorker } from '../browser/worker/serve';
import type { sidekickProtocol } from '../protocol';
import type { Registry } from '../registry/registry';
import type { Handlers } from '../rpc/define';
import { type McpHub, mcpHubs, type McpPairing, mcpPairings } from '../storage/items';
import type { ToolCaller } from '../tool/bridge';
import type { ToolDefinition } from '../tool/tool';
import { pairHandlers } from './pair';
import { findPairing } from './pairings';
import { createMcpServer, KEEPALIVE } from './server';
import { connectionTools } from './tools';
import { isLoopbackHub, openSocket, type Socket, socketTransport } from './transport';

const NAME_LENGTH = 32;

function clientName(info: { name: string; title?: string } | undefined) {
  const name = (info?.title ?? info?.name ?? '')
    .replaceAll(/\p{Cc}/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  const chars = [...name];

  return chars.length > NAME_LENGTH ? `${chars.slice(0, NAME_LENGTH - 1).join('')}…` : name;
}

/**
 * A connection's tab group title: the pairing's name, then the client's `title` or `name`
 * from `initialize` when the pairing is Other and the client names itself differently.
 */
export function groupTitle(
  pairing: Pick<McpPairing, 'name' | 'client'>,
  info: { name: string; title?: string } | undefined,
) {
  const name = clientName(info);

  if (pairing.client !== 'other' || !name) return pairing.name;

  return name.toLowerCase() === pairing.name.toLowerCase()
    ? pairing.name
    : `${pairing.name} · ${name}`;
}

export type McpHandlers = Pick<
  Handlers<(typeof sidekickProtocol)['methods']>,
  'mcp.connect' | 'mcp.disconnect' | 'mcp.pair' | 'mcp.unpair'
>;

export type McpConnectResult = Awaited<ReturnType<McpHandlers['mcp.connect']>>;

export interface McpHostOptions {
  tools: Pick<Registry<ToolDefinition>, 'list' | 'subscribe'>;
  caller: ToolCaller;
  worker: Pick<BrowserWorker, 'clientRun' | 'endClient' | 'clientGroup'>;
  /** The last-focused normal window, where a connection's later runs open their tab. */
  lastWindow: () => Promise<number | undefined>;
  version: string;
  /** Opens a socket; a browser `WebSocket` unless a test passes its own. */
  dial?: (url: string) => Socket;
}

export interface McpHost {
  /** `mcp.connect`, `mcp.pair` and `mcp.unpair` for the connect page, `mcp.disconnect` for Connected agents. */
  handlers: McpHandlers;
  /** Dials a hub the connect page passed, for the pairing its token names. */
  connect: (input: { hub: string; token: string; tabId?: number }) => Promise<McpConnectResult>;
  /** Closes every connection of a pairing. */
  disconnect: (pairingID: string) => void;
  /** Redials the hubs kept in `storage.session`, after the worker restarts. */
  restore: () => Promise<void>;
  dispose: () => void;
}

interface Connection {
  id: string;
  hub: string;
  pairing: McpPairing;
  tabId?: number;
  started: boolean;
  close: () => void;
}

function withToken(hub: string, token: string) {
  const url = new URL(hub);

  url.searchParams.set('token', token);

  return url.href;
}

/**
 * The worker's MCP host: one connection per helper hub, each with its own MCP server and run,
 * a ping every 20 s, and its hub kept in `storage.session` so a restarted worker redials it.
 * Revoking a pairing, or replacing its token, closes its connections.
 */
export function createMcpHost(options: McpHostOptions): McpHost {
  const { tools, caller, worker, lastWindow, version } = options;
  const dial = options.dial ?? ((url: string) => new WebSocket(url));
  const connections = new Map<string, Connection>();
  const dialing = new Map<string, Promise<McpConnectResult>>();
  let disposed = false;
  let writes = Promise.resolve();

  const save = (change: (hubs: McpHub[]) => McpHub[]) => {
    writes = writes
      .then(async () => mcpHubs.set(change(await mcpHubs.get())))
      .catch(() => undefined);

    return writes;
  };

  const start = async (hub: string, token: string, pairing: McpPairing, tabId?: number) => {
    const socket = dial(withToken(hub, token));

    try {
      await openSocket(socket);
    } catch {
      return { connected: false, reason: 'unreachable' } as const;
    }

    const connection: Connection = {
      id: `mcp_${crypto.randomUUID()}`,
      hub,
      pairing,
      ...(tabId === undefined ? {} : { tabId }),
      started: false,
      close: () => socket.close(),
    };

    const server = createMcpServer({
      tools,
      caller,
      version,
      connectionID: connection.id,
      client: { id: pairing.id, name: pairing.name },
      extra: connectionTools({ connectionID: connection.id, pairing, worker, version }),
      run: async () => {
        const run = await worker.clientRun({
          connectionID: connection.id,
          label: groupTitle(pairing, server.getClientVersion()),
          ...(connection.started || connection.tabId === undefined
            ? {}
            : { tabId: connection.tabId }),
          lastWindow,
        });

        connection.started = true;

        return run;
      },
    });

    const ping = setInterval(() => {
      void server.ping().catch(() => undefined);
    }, KEEPALIVE);

    socket.addEventListener('close', () => {
      clearInterval(ping);
      worker.endClient(connection.id);

      if (connections.get(hub) !== connection) return;

      connections.delete(hub);

      if (!disposed) void save((hubs) => hubs.filter((entry) => entry.hub !== hub));
    });

    connections.set(hub, connection);

    await server.connect(socketTransport(socket));

    await save((hubs) => [
      ...hubs.filter((entry) => entry.hub !== hub),
      { hub, token, pairingID: pairing.id },
    ]);

    return { connected: true, name: pairing.name, adopted: tabId !== undefined } as const;
  };

  const connect = async ({ hub, token, tabId }: { hub: string; token: string; tabId?: number }) => {
    if (!isLoopbackHub(hub)) return { connected: false, reason: 'not_loopback' } as const;

    const pairing = await findPairing(token);

    if (!pairing) return { connected: false, reason: 'unknown_token' } as const;

    await dialing.get(hub);

    const live = connections.get(hub);

    if (live) {
      const adopted = tabId !== undefined && !live.started && live.tabId === undefined;

      if (adopted) live.tabId = tabId;

      return { connected: true, name: live.pairing.name, adopted } as const;
    }

    const pending = start(hub, token, pairing, tabId);

    dialing.set(hub, pending);

    try {
      return await pending;
    } finally {
      dialing.delete(hub);
    }
  };

  const unwatch = mcpPairings.watch((pairings) => {
    for (const connection of [...connections.values()]) {
      const current = pairings.find((pairing) => pairing.id === connection.pairing.id);

      if (current?.hash !== connection.pairing.hash) connection.close();
    }
  });

  const disconnect = (pairingID: string) => {
    for (const connection of [...connections.values()]) {
      if (connection.pairing.id === pairingID) connection.close();
    }
  };

  return {
    handlers: {
      'mcp.connect': connect,
      'mcp.disconnect': ({ pairingID }) => {
        disconnect(pairingID);

        return {};
      },
      ...pairHandlers(dial),
    },
    connect,
    disconnect,
    restore: async () => {
      const hubs = await mcpHubs.get();

      const results = await Promise.all(
        hubs.map(async (entry) => ({ entry, result: await connect(entry) })),
      );

      const lost = new Set(
        results.filter(({ result }) => !result.connected).map(({ entry }) => entry.hub),
      );

      if (lost.size > 0) await save((current) => current.filter((entry) => !lost.has(entry.hub)));
    },
    dispose: () => {
      disposed = true;
      unwatch();

      for (const connection of [...connections.values()]) connection.close();
    },
  };
}
