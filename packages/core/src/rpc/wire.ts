import * as z from 'zod/mini';

export const PORT_NAME = 'sidekick';

const id = z.string().check(z.minLength(1));

const code = z.enum(['disconnected', 'invalid', 'unknown-method', 'timeout', 'failed']);

export type RpcErrorCode = z.infer<typeof code>;

export class RpcError extends Error {
  override readonly name = 'RpcError';

  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const requestMessage = z.object({
  kind: z.literal('request'),
  id,
  method: z.string(),
  input: z.unknown(),
});

export const responseMessage = z.object({ kind: z.literal('response'), id, output: z.unknown() });

export const errorMessage = z.object({
  kind: z.literal('error'),
  id,
  error: z.object({ code, message: z.string() }),
});

export const eventMessage = z.object({
  kind: z.literal('event'),
  id,
  created: z.number(),
  type: z.string(),
  data: z.unknown(),
});

export const heartbeatMessage = z.object({ kind: z.literal('heartbeat') });

export const clientMessage = z.discriminatedUnion('kind', [requestMessage, heartbeatMessage]);

export const replyMessage = z.discriminatedUnion('kind', [responseMessage, errorMessage]);

export const serverMessage = z.discriminatedUnion('kind', [
  responseMessage,
  errorMessage,
  eventMessage,
]);

export type RequestMessage = z.infer<typeof requestMessage>;

export type ReplyMessage = z.infer<typeof replyMessage>;

export type EventMessage = z.infer<typeof eventMessage>;

export function failure(id: string, code: RpcErrorCode, message: string): ReplyMessage {
  return { kind: 'error', id, error: { code, message } };
}

export function idOf(message: unknown) {
  if (typeof message !== 'object' || message === null || !('id' in message)) return undefined;

  return id.safeParse(message.id).data;
}
