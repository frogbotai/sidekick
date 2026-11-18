import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { type WebSocket, WebSocketServer } from 'ws';

/** Sidekick's Chrome Web Store ID, fixed by the manifest's `key`. */
export const STORE_EXTENSION_ID = 'kilnglameccalibejghopglodbidhkmj';

export interface Hub {
  /** `ws://127.0.0.1:<port>/<secret>`, the address the connect page passes to Sidekick. */
  url: string;
  close: () => Promise<void>;
}

export interface HubOptions {
  /** `SIDEKICK_TOKEN`; with none, every socket is refused. */
  token: string | undefined;
  extensionId: string;
  onSocket: (socket: WebSocket) => void;
}

function digest(text: string) {
  return createHash('sha256').update(text).digest();
}

function sameToken(given: string | null, token: string | undefined) {
  return !!given && !!token && timingSafeEqual(digest(given), digest(token));
}

/** Why an upgrade is refused, or undefined when it may connect. */
export function refusal(
  request: Pick<IncomingMessage, 'url' | 'headers'>,
  { path, token, extensionId }: { path: string; token: string | undefined; extensionId: string },
) {
  const url = new URL(request.url ?? '/', 'ws://127.0.0.1');

  if (request.headers.origin !== `chrome-extension://${extensionId}`) return 'origin';

  if (url.pathname !== path) return 'path';

  if (!sameToken(url.searchParams.get('token'), token)) return 'token';

  return undefined;
}

type Refuse = (request: Pick<IncomingMessage, 'url' | 'headers'>, path: string) => unknown;

type OnSocket = (socket: WebSocket, request: IncomingMessage) => void;

async function listen(refuse: Refuse, onSocket: OnSocket) {
  const path = `/${randomBytes(18).toString('base64url')}`;
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer((_request, response) => response.writeHead(404).end());

  server.on('upgrade', (request, socket, head) => {
    if (refuse(request, path)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');

      return;
    }

    sockets.handleUpgrade(request, socket, head, onSocket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate();

        sockets.close();
        server.close(() => resolve());
      }),
  };
}

/**
 * The helper's hub: a WebSocket server on 127.0.0.1, an ephemeral port and a random path. It takes
 * only Sidekick's origin with the path and the paired token; anything else gets a 403.
 */
export function startHub({ token, extensionId, onSocket }: HubOptions): Promise<Hub> {
  return listen((request, path) => refusal(request, { path, token, extensionId }), onSocket);
}

/** How long a pairing request works: ten minutes. */
export const PAIR_TTL = 10 * 60_000;

/** The key Sidekick sends when the person approves a pairing request. */
export interface PairedKey {
  key: string;
  pairingID: string;
}

export interface PairHub extends Hub {
  /** The request's id, which the connect page passes back as `?pair=`. */
  id: string;
  /** Resolves once Sidekick's Approve page for this request has loaded. */
  shown: Promise<void>;
  /** The key, or undefined once the request expires, fails or the hub closes. */
  paired: Promise<PairedKey | undefined>;
}

function pairedKey(data: unknown): PairedKey | undefined {
  try {
    const value: unknown = JSON.parse(String(data));

    if (typeof value !== 'object' || value === null) return undefined;

    const { type, key, pairingID } = value as Record<string, unknown>;

    if (type !== 'sidekick/paired' || typeof key !== 'string' || !key) return undefined;

    return { key, pairingID: typeof pairingID === 'string' ? pairingID : '' };
  } catch {
    return undefined;
  }
}

/**
 * A hub in pair mode: one request, good for `ttl` and for one socket. That socket must carry
 * Sidekick's origin, the path and `?pair=<id>`, and its first message is the new key, which the
 * hub acknowledges. Every later socket, and any socket after expiry, gets a 403; on expiry the
 * hub drops a socket that holds the request and acknowledges nothing it sends. A socket that also
 * carries `&shown=1` is the Approve page saying it loaded: it resolves `shown` and leaves the
 * request unspent.
 */
export async function startPairHub({
  extensionId,
  ttl = PAIR_TTL,
}: {
  extensionId: string;
  ttl?: number;
}): Promise<PairHub> {
  const id = randomBytes(18).toString('base64url');
  let open = true;
  let held: WebSocket | undefined;
  let markShown: () => void = () => undefined;
  const shown = new Promise<void>((resolve) => (markShown = resolve));
  let resolvePaired: (value: PairedKey | undefined) => void = () => undefined;
  const paired = new Promise<PairedKey | undefined>((resolve) => (resolvePaired = resolve));

  let done = false;

  const settle = (value: PairedKey | undefined) => {
    open = false;
    done = true;
    resolvePaired(value);
  };

  const timer = setTimeout(() => {
    settle(undefined);
    held?.terminate();
  }, ttl);

  const hub = await listen(
    (request, path) => {
      const url = new URL(request.url ?? '/', 'ws://127.0.0.1');

      if (request.headers.origin !== `chrome-extension://${extensionId}`) return 'origin';

      if (url.pathname !== path) return 'path';

      if (!sameToken(url.searchParams.get('pair'), id)) return 'pair';

      return open ? undefined : 'used';
    },
    (socket, request) => {
      markShown();

      if (new URL(request.url ?? '/', 'ws://127.0.0.1').searchParams.get('shown') === '1') {
        socket.close();

        return;
      }

      open = false;
      held = socket;

      socket.once('message', (data) => {
        const key = done ? undefined : pairedKey(data);

        if (key) socket.send(JSON.stringify({ type: 'sidekick/ok' }));

        socket.close();
        settle(key);
      });

      socket.once('close', () => settle(undefined));
    },
  );

  return {
    ...hub,
    id,
    shown,
    paired,
    close: () => {
      clearTimeout(timer);
      settle(undefined);

      return hub.close();
    },
  };
}
