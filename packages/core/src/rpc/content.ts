import { CALL_TIMEOUT, readReply } from './client';
import type { Handlers, Input, Methods, Output } from './define';
import { dispatch } from './server';
import { RpcError } from './wire';

/** The tab and frame a content script's message came from, as Chrome reports it. */
export interface ContentSender {
  tabId: number;
  frameId: number;
}

/** Calls the worker from a content script. The worker learns the tab from `sender.tab`, never from the input. */
export async function callWorker<M extends Methods, K extends keyof M & string>(
  protocol: { methods: M },
  method: K,
  input: Input<M, K>,
  { timeout = CALL_TIMEOUT }: { timeout?: number } = {},
): Promise<Output<M, K>> {
  const definition = protocol.methods[method];

  if (!definition) throw new RpcError('unknown-method', `Unknown method "${method}"`);

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcError('timeout', `"${method}" took longer than ${timeout} ms`)),
      timeout,
    );
  });

  const sent = chrome.runtime
    .sendMessage({ kind: 'request', id: crypto.randomUUID(), method, input })
    .catch((error: unknown) => {
      throw new RpcError('disconnected', error instanceof Error ? error.message : String(error));
    });

  try {
    return readReply(definition, method, await Promise.race([sent, timedOut])) as Output<M, K>;
  } finally {
    clearTimeout(timer);
  }
}

/** Answers content scripts in the worker: only this extension's scripts, and only from a tab. */
export function answerContent<M extends Methods>(
  protocol: { methods: M },
  handlers: (sender: ContentSender) => Handlers<M>,
) {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (sender.id !== chrome.runtime.id || tabId === undefined) return undefined;

    const from = { tabId, frameId: sender.frameId ?? 0 };

    void dispatch(protocol.methods, handlers(from), message).then(sendResponse);

    return true;
  });
}
