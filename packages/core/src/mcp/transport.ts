import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

/** The parts of a browser `WebSocket` the transport uses. */
export type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;

const OPEN = 1;

function parse(data: unknown): JSONRPCMessage | Error {
  if (typeof data !== 'string') return new Error('MCP frames must be text');

  try {
    return JSON.parse(data) as JSONRPCMessage;
  } catch {
    return new Error('An MCP frame wasn’t JSON');
  }
}

/** The MCP SDK's `Transport` over an open WebSocket: one JSON-RPC message per text frame. */
export function socketTransport(socket: Socket): Transport {
  let closed = false;

  const transport: Transport = {
    start: () => {
      socket.addEventListener('message', (event) => {
        const message = parse(event.data);

        if (message instanceof Error) transport.onerror?.(message);
        else transport.onmessage?.(message);
      });

      socket.addEventListener('close', () => {
        if (closed) return;

        closed = true;
        transport.onclose?.();
      });

      socket.addEventListener('error', () => {
        transport.onerror?.(new Error('The MCP socket failed'));
      });

      return Promise.resolve();
    },
    send: (message) => {
      if (socket.readyState !== OPEN) {
        return Promise.reject(new Error('The MCP socket is closed'));
      }

      socket.send(JSON.stringify(message));

      return Promise.resolve();
    },
    close: () => {
      if (!closed) {
        closed = true;
        socket.close();
        transport.onclose?.();
      }

      return Promise.resolve();
    },
  };

  return transport;
}
