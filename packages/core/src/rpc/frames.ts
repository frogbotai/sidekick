import { CALL_TIMEOUT, readReply } from './client';
import type { Handlers, Input, Methods, Output } from './define';
import { dispatch } from './server';
import { type RequestMessage, RpcError } from './wire';

export async function callFrame<M extends Methods, K extends keyof M & string>(
  protocol: { methods: M },
  target: { tabId: number; frameId: number },
  method: K,
  input: Input<M, K>,
  { timeout = CALL_TIMEOUT }: { timeout?: number } = {},
): Promise<Output<M, K>> {
  const definition = protocol.methods[method];

  if (!definition) throw new RpcError('unknown-method', `Unknown method "${method}"`);

  const { tabId, frameId } = target;
  const request: RequestMessage = { kind: 'request', id: crypto.randomUUID(), method, input };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcError('timeout', `"${method}" took longer than ${timeout} ms`)),
      timeout,
    );
  });

  const sent = chrome.tabs.sendMessage(tabId, request, { frameId }).catch((error: unknown) => {
    throw new RpcError('disconnected', error instanceof Error ? error.message : String(error));
  });

  try {
    const reply: unknown = await Promise.race([sent, timedOut]);

    return readReply(definition, method, reply) as Output<M, K>;
  } finally {
    clearTimeout(timer);
  }
}

export function answerFrames<M extends Methods>(protocol: { methods: M }, handlers: Handlers<M>) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return undefined;

    void dispatch(protocol.methods, handlers, message).then(sendResponse);

    return true;
  });
}
