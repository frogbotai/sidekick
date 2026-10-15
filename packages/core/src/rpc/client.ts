import * as z from 'zod/mini';
import type { output } from 'zod/v4/core';

import { CONNECTED, type Input, type MethodDefinition, type Output, type Protocol } from './define';
import { eventMessage, idOf, PORT_NAME, replyMessage, RpcError } from './wire';

export const CALL_TIMEOUT = 30_000;

export const HEARTBEAT = 20_000;

export const MIN_BACKOFF = 100;

export const MAX_BACKOFF = 2_000;

type EventListener = (data: unknown) => void;

interface Pending {
  method: string;
  resolve: (output: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Per-call options: `timeout: false` waits as long as the worker takes, for tool calls. */
export interface CallOptions {
  timeout?: number | false;
}

export interface WorkerClient<P extends Protocol> {
  call: <K extends keyof P['methods'] & string>(
    method: K,
    input: Input<P['methods'], K>,
    options?: CallOptions,
  ) => Promise<Output<P['methods'], K>>;
  on: <K extends keyof P['events'] & string>(
    type: K,
    listener: (data: output<P['events'][K]>) => void,
  ) => () => void;
  close: () => void;
}

export function readReply(definition: MethodDefinition, method: string, message: unknown) {
  const reply = replyMessage.safeParse(message);

  if (!reply.success) throw new RpcError('invalid', `Invalid reply to "${method}"`);

  if (reply.data.kind === 'error') {
    throw new RpcError(reply.data.error.code, reply.data.error.message);
  }

  const parsed = z.safeParse(definition.output, reply.data.output);

  if (!parsed.success) throw new RpcError('invalid', `Invalid output from "${method}"`);

  return parsed.data;
}

export function connectWorker<P extends Protocol>(
  protocol: P,
  { timeout = CALL_TIMEOUT }: { timeout?: number } = {},
): WorkerClient<P> {
  const pending = new Map<string, Pending>();
  const listeners = new Map<string, Set<EventListener>>();
  let port: chrome.runtime.Port | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = MIN_BACKOFF;
  let sequence = 0;
  let closed = false;

  const settle = (id: string) => {
    const call = pending.get(id);

    if (!call) return undefined;

    pending.delete(id);
    clearTimeout(call.timer);

    return call;
  };

  const rejectAll = () => {
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(new RpcError('disconnected', 'The worker disconnected'));
    }
  };

  const deliver = (type: string, data: unknown) => {
    const schema = Object.hasOwn(protocol.events, type) ? protocol.events[type] : undefined;
    const parsed = schema && z.safeParse(schema, data);

    if (!parsed?.success) return;

    if (type === CONNECTED) backoff = MIN_BACKOFF;

    for (const listener of [...(listeners.get(type) ?? [])]) listener(parsed.data);
  };

  const receive = (message: unknown) => {
    const event = eventMessage.safeParse(message);

    if (event.success) return deliver(event.data.type, event.data.data);

    const id = idOf(message);
    const call = id === undefined ? undefined : settle(id);
    const definition = call && protocol.methods[call.method];

    if (!call || !definition) return;

    try {
      call.resolve(readReply(definition, call.method, message));
    } catch (error) {
      call.reject(error instanceof RpcError ? error : new RpcError('invalid', String(error)));
    }
  };

  const dropped = () => {
    clearInterval(heartbeat);
    port = undefined;
    rejectAll();

    if (closed) return;

    retry = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };

  function open() {
    retry = undefined;

    let next: chrome.runtime.Port;

    try {
      next = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      dropped();

      return;
    }

    port = next;

    next.onMessage.addListener((message: unknown) => {
      if (port === next) receive(message);
    });

    next.onDisconnect.addListener(() => {
      if (port === next) dropped();
    });

    heartbeat = setInterval(() => {
      try {
        next.postMessage({ kind: 'heartbeat' });
      } catch {}
    }, HEARTBEAT);
  }

  open();

  return {
    call: (method, input, { timeout: limit = timeout }: CallOptions = {}) => {
      const result = new Promise<unknown>((resolve, reject) => {
        if (!Object.hasOwn(protocol.methods, method)) {
          reject(new RpcError('unknown-method', `Unknown method "${method}"`));

          return;
        }

        if (!port) {
          reject(new RpcError('disconnected', 'The worker is not connected'));

          return;
        }

        const id = String(++sequence);

        const timer =
          limit === false
            ? undefined
            : setTimeout(() => {
                settle(id)?.reject(
                  new RpcError('timeout', `"${method}" took longer than ${limit} ms`),
                );
              }, limit);

        pending.set(id, { method, resolve, reject, timer });

        try {
          port.postMessage({ kind: 'request', id, method, input });
        } catch {
          settle(id)?.reject(new RpcError('disconnected', 'The worker disconnected'));
        }
      });

      return result as Promise<Output<P['methods'], typeof method>>;
    },
    on: (type, listener) => {
      const set = listeners.get(type) ?? new Set();

      set.add(listener as EventListener);
      listeners.set(type, set);

      return () => void set.delete(listener as EventListener);
    },
    close: () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);

      const current = port;

      port = undefined;
      current?.disconnect();
      rejectAll();
    },
  };
}
