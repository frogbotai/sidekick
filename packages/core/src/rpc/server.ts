import * as z from 'zod/mini';
import type { input } from 'zod/v4/core';

import { CONNECTED, type Handlers, type Methods, type Protocol } from './define';
import {
  type EventMessage,
  failure,
  heartbeatMessage,
  idOf,
  PORT_NAME,
  type ReplyMessage,
  requestMessage,
} from './wire';

type AnyHandler = (input: unknown) => unknown;

export interface Server<P extends Protocol> {
  emit: <K extends Exclude<keyof P['events'], typeof CONNECTED> & string>(
    type: K,
    data: input<P['events'][K]>,
  ) => void;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatch<M extends Methods>(
  methods: M,
  handlers: Handlers<M>,
  message: unknown,
): Promise<ReplyMessage | undefined> {
  const request = requestMessage.safeParse(message);

  if (!request.success) {
    const id = idOf(message);

    return id === undefined ? undefined : failure(id, 'invalid', 'Not a valid request');
  }

  const { id, method, input } = request.data;
  const definition = Object.hasOwn(methods, method) ? methods[method] : undefined;

  const handler = Object.hasOwn(handlers, method)
    ? (handlers as Record<string, AnyHandler>)[method]
    : undefined;

  if (!definition || !handler) return failure(id, 'unknown-method', `Unknown method "${method}"`);

  const parsed = z.safeParse(definition.input, input);

  if (!parsed.success) {
    return failure(
      id,
      'invalid',
      `Invalid input for "${method}": ${z.prettifyError(parsed.error)}`,
    );
  }

  try {
    return { kind: 'response', id, output: await handler(parsed.data) };
  } catch (error) {
    return failure(id, 'failed', messageOf(error));
  }
}

export function isTrustedPage(sender: chrome.runtime.MessageSender | undefined) {
  return sender?.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

export function serve<P extends Protocol>(
  protocol: P,
  handlers: Handlers<P['methods']>,
  { bootId }: { bootId: string },
): Server<P> {
  const ports = new Set<chrome.runtime.Port>();

  const post = (port: chrome.runtime.Port, message: ReplyMessage | EventMessage) => {
    if (!ports.has(port)) return;

    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  };

  const event = (type: string, data: unknown): EventMessage => ({
    kind: 'event',
    id: crypto.randomUUID(),
    created: Date.now(),
    type,
    data,
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME || !isTrustedPage(port.sender)) {
      port.disconnect();

      return;
    }

    ports.add(port);
    port.onDisconnect.addListener(() => void ports.delete(port));

    port.onMessage.addListener((message: unknown) => {
      if (heartbeatMessage.safeParse(message).success) return;

      void dispatch(protocol.methods, handlers, message).then((reply) => {
        if (reply) post(port, reply);
      });
    });

    post(port, event(CONNECTED, { bootId }));
  });

  return {
    emit: (type, data) => {
      for (const port of ports) post(port, event(type, data));
    },
  };
}
