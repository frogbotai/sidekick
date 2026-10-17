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

/**
 * The helper's hub: a WebSocket server on 127.0.0.1, an ephemeral port and a random path. It takes
 * only Sidekick's origin with the path and the paired token; anything else gets a 403.
 */
export async function startHub({ token, extensionId, onSocket }: HubOptions): Promise<Hub> {
  const path = `/${randomBytes(18).toString('base64url')}`;
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer((_request, response) => response.writeHead(404).end());

  server.on('upgrade', (request, socket, head) => {
    if (refusal(request, { path, token, extensionId })) {
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
      new Promise((resolve) => {
        for (const client of sockets.clients) client.terminate();

        sockets.close();
        server.close(() => resolve());
      }),
  };
}
