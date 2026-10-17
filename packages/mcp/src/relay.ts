import type { Cache } from './cache.js';

/** The parts of a `ws` socket the relay uses. */
export interface RelaySocket {
  send: (data: string) => void;
  close: () => void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** What a client gets for a call the worker's restart cut off; Sidekick's `NOT_CONNECTED`. */
export const NOT_CONNECTED =
  'Sidekick’s background worker restarted, which ended the task’s tab group. Call the tool again to start a new one; take a new snapshot first.';

/** How long a request waits for Sidekick to connect after the helper wakes it. */
export const CONNECT_TIMEOUT = 30_000;

export const NO_TOKEN =
  'SIDEKICK_TOKEN isn’t set. In Sidekick’s settings, open Connected agents, add this app and run the command it shows.';

export const NO_CONNECTION =
  'Sidekick didn’t connect. Check that Chrome is open with Sidekick installed, and that the command came from Sidekick’s settings (Connected agents); New command there replaces an old token.';

type Id = string | number;

export interface Message {
  jsonrpc: '2.0';
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface RelayOptions {
  cache: Cache;
  /** Writes one message to the client, on stdout. */
  send: (message: Message) => void;
  /** Opens the connect page, to wake Sidekick. */
  wake: () => Promise<void>;
  hasToken: boolean;
  timeout?: number;
}

export interface Relay {
  /** A message from the client, off stdin. */
  fromClient: (message: Message) => void;
  /** A socket the hub accepted from Sidekick. */
  attach: (socket: RelaySocket) => void;
  close: () => void;
}

const PRIVATE = 'sidekick-mcp:';

const isRequest = (message: Message) => message.id !== undefined && message.method !== undefined;

const isResponse = (message: Message) => message.id !== undefined && message.method === undefined;

function parse(data: unknown): Message | undefined {
  try {
    const value: unknown = JSON.parse(String(data));

    return typeof value === 'object' && value !== null ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Relays MCP between the client and Sidekick unchanged. It answers `initialize`, `tools/list` and
 * `ping` from the cache while no socket is live, wakes Sidekick on the first request that needs
 * the browser, replays the client's `initialize` on each new socket, and answers calls a dropped
 * socket cut off with `NOT_CONNECTED`.
 */
export function createRelay({
  cache,
  send,
  wake,
  hasToken,
  timeout = CONNECT_TIMEOUT,
}: RelayOptions): Relay {
  let socket: RelaySocket | undefined;
  let ready = false;
  let initialize: Message | undefined;
  let servedTools = false;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  let next = 0;
  const queue: Message[] = [];
  const pending = new Map<Id, Message>();
  const own = new Map<Id, 'initialize' | 'tools'>();

  const fail = (request: Message, text: string) => {
    if (request.method === 'tools/call') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { isError: true, content: [{ type: 'text', text }] },
      });
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: text } });
    }
  };

  const toWorker = (message: Message) => {
    if (isRequest(message) && message.id !== undefined) pending.set(message.id, message);

    socket?.send(JSON.stringify(message));
  };

  const ask = (method: string, kind: 'initialize' | 'tools', params?: Record<string, unknown>) => {
    const id = `${PRIVATE}${next++}`;

    own.set(id, kind);
    socket?.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
  };

  const flush = () => {
    ready = true;

    if (waiting) clearTimeout(waiting);

    waiting = undefined;

    for (const message of queue.splice(0)) toWorker(message);
  };

  const giveUp = (text: string) => {
    for (const message of queue.splice(0)) if (isRequest(message)) fail(message, text);
  };

  const ensure = () => {
    if (waiting || socket) return;

    if (!hasToken) {
      void wake().catch(() => undefined);
      giveUp(NO_TOKEN);

      return;
    }

    waiting = setTimeout(() => {
      waiting = undefined;
      giveUp(NO_CONNECTION);
    }, timeout);

    void wake().catch(() => undefined);
  };

  const deliver = (message: Message) => {
    if (ready) {
      toWorker(message);

      return;
    }

    queue.push(message);

    if (isRequest(message)) ensure();
  };

  const fromCache = async (request: Message) => {
    const cached = await cache.read();

    if (request.method === 'initialize') {
      const version = request.params?.protocolVersion;

      if (cached.initialize !== undefined && cached.protocolVersion === version) {
        return cached.initialize;
      }

      return undefined;
    }

    if (request.method === 'tools/list' && !request.params?.cursor) {
      if (cached.tools !== undefined) servedTools = true;

      return cached.tools;
    }

    return request.method === 'ping' ? {} : undefined;
  };

  const fromWorker = (message: Message) => {
    if (isResponse(message) && message.id !== undefined && own.has(message.id)) {
      const kind = own.get(message.id);

      own.delete(message.id);

      if (kind === 'initialize') {
        if (message.result !== undefined) {
          void cache.write({
            protocolVersion: String(initialize?.params?.protocolVersion),
            initialize: message.result,
          });
        }

        socket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        ask('tools/list', 'tools');
        flush();
      } else if (message.result !== undefined) {
        void cache.read().then(async (cached) => {
          const changed = JSON.stringify(cached.tools) !== JSON.stringify(message.result);

          await cache.write({ tools: message.result });

          if (changed && servedTools) {
            send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          }
        });
      }

      return;
    }

    if (isResponse(message) && message.id !== undefined) {
      const request = pending.get(message.id);

      pending.delete(message.id);

      if (request?.method === 'initialize' && message.result !== undefined) {
        void cache.write({
          protocolVersion: String(request.params?.protocolVersion),
          initialize: message.result,
        });
      }

      if (request?.method === 'tools/list' && !request.params?.cursor && message.result) {
        void cache.write({ tools: message.result });
      }
    }

    send(message);
  };

  const drop = () => {
    own.clear();

    for (const request of pending.values()) fail(request, NOT_CONNECTED);

    pending.clear();
  };

  const detach = (closed: RelaySocket) => {
    if (socket !== closed) return;

    socket = undefined;
    ready = false;
    drop();

    if (queue.some(isRequest)) ensure();
  };

  return {
    fromClient: (message) => {
      if (message.method === 'initialize') initialize = message;

      if (isRequest(message) && !socket) {
        void fromCache(message).then((result) => {
          if (result === undefined || socket) deliver(message);
          else send({ jsonrpc: '2.0', id: message.id, result });
        });

        return;
      }

      if (!isRequest(message) && !ready) {
        if (queue.length > 0) queue.push(message);

        return;
      }

      deliver(message);
    },
    attach: (incoming) => {
      const previous = socket;

      socket = incoming;
      ready = false;

      if (previous) {
        drop();
        previous.close();
      }

      incoming.on('message', (data) => {
        const message = parse(data);

        if (message && socket === incoming) fromWorker(message);
      });

      incoming.on('close', () => detach(incoming));

      const queuedInit = queue.some((message) => message.method === 'initialize');

      if (initialize && !queuedInit) ask('initialize', 'initialize', initialize.params);
      else flush();
    },
    close: () => {
      if (waiting) clearTimeout(waiting);

      socket?.close();
    },
  };
}
