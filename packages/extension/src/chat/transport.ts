import {
  CHAT_FULL,
  type CompactionData,
  fromUIParts,
  isDenial,
  type LogEvent,
  type SessionEngine,
  type TokenUsage,
  toolOutput,
} from '@frogbotai/sidekick-core';
import type { ChatId, ChatRequestState } from '@frogbotai/ui/chat';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

/** A retry the engine has scheduled: attempt `attempt`, at time `at`. */
export interface RetryNotice {
  attempt: number;
  at: number;
}

/** The window's open chat, after 278 D1 and D2: opening another one ends the previous run. */
export interface WindowChat {
  current: () => string | undefined;
  open: (sessionID: string | undefined) => Promise<void>;
}

export interface SessionTransportOptions {
  engine: SessionEngine;
  chat: WindowChat;
  request: () => ChatRequestState;
  onChatId: (chatId: ChatId) => void;
  /** Whether another window holds the session's turn lock. */
  heldElsewhere: (sessionID: string) => Promise<boolean>;
  /** The permission mode picked for the next message, sent with it like the model. */
  mode?: () => string | undefined;
  onRetry?: (sessionID: string, notice: RetryNotice | undefined) => void;
  /**
   * Called when a stream starts and when it settles; `reload` when the stream can't show the turn
   * as the log stores it: it waited behind another turn, or took a steer.
   */
  onStreaming?: (sessionID: string, streaming: boolean, reload: boolean) => void;
}

type Send = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];

function modelRef({ model, reasoning }: ChatRequestState) {
  if (!model) return undefined;

  return reasoning ? `${model}#${reasoning}` : model;
}

function tokensOf(tokens: TokenUsage | undefined) {
  return tokens ? { tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0 } } : {};
}

/**
 * Turns one turn's engine events into `useChat` chunks, after the research table. A compaction is
 * a `data-compaction` part with the compaction's id, so each update replaces it in place; a tool's
 * progress re-sends its input with the progress as `toolMetadata`. A message the turn takes after
 * its own is a steer, a `data-steered` part where the turn took it, and `steered()` turns true.
 */
export function chunker() {
  let started = false;
  let steered = false;
  let open = false;
  let failure: string | undefined;
  const reasons = new Map<string, CompactionData['reason']>();
  const calls = new Map<string, { name: string; input: unknown }>();

  const head = (messageID: string): UIMessageChunk[] => {
    if (started) return [];

    started = true;

    return [{ type: 'start', messageId: messageID }];
  };

  const step = (messageID: string): UIMessageChunk[] => {
    if (open) return [];

    open = true;

    return [...head(messageID), { type: 'start-step' }];
  };

  const compaction = (messageID: string, data: Omit<CompactionData, 'reason'>) => ({
    chunks: [
      ...head(messageID),
      {
        type: 'data-compaction' as const,
        id: messageID,
        data: { ...data, reason: reasons.get(messageID) ?? 'auto' },
      },
    ],
  });

  const end = (): UIMessageChunk[] => {
    if (!open) return [];

    open = false;

    return [{ type: 'finish-step' }];
  };

  const map = (event: LogEvent): { chunks: UIMessageChunk[]; done?: boolean } => {
    switch (event.type) {
      case 'session.prompted':
        steered = true;

        return {
          chunks: [
            ...head(event.messageID),
            {
              type: 'data-steered',
              id: event.messageID,
              data: {
                messageId: event.messageID,
                text: event.parts
                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  .join('\n'),
              },
            },
          ],
        };
      case 'session.step.started':
        return { chunks: step(event.messageID) };
      case 'session.step.ended':
        return { chunks: end() };
      case 'session.step.failed':
        failure = event.error.message;

        return { chunks: end() };
      case 'session.text.started':
        return { chunks: [{ type: 'text-start', id: event.partID }] };
      case 'session.text.delta':
        return { chunks: [{ type: 'text-delta', id: event.partID, delta: event.delta }] };
      case 'session.text.ended':
        return {
          chunks: [
            {
              type: 'text-end',
              id: event.partID,
              ...(event.state ? { providerMetadata: event.state } : {}),
            },
          ],
        };
      case 'session.reasoning.started':
        return { chunks: [{ type: 'reasoning-start', id: event.partID }] };
      case 'session.reasoning.delta':
        return { chunks: [{ type: 'reasoning-delta', id: event.partID, delta: event.delta }] };
      case 'session.reasoning.ended':
        return {
          chunks: [
            {
              type: 'reasoning-end',
              id: event.partID,
              ...(event.state ? { providerMetadata: event.state } : {}),
            },
          ],
        };
      case 'session.tool.input.started':
        return {
          chunks: [
            {
              type: 'tool-input-start',
              toolCallId: event.callID,
              toolName: event.name,
              dynamic: true,
            },
          ],
        };
      case 'session.tool.input.delta':
        return {
          chunks: [
            { type: 'tool-input-delta', toolCallId: event.callID, inputTextDelta: event.delta },
          ],
        };
      case 'session.tool.called':
        calls.set(event.callID, { name: event.name, input: event.input });

        return {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: event.callID,
              toolName: event.name,
              input: event.input,
              dynamic: true,
              ...(event.providerState ? { providerMetadata: event.providerState } : {}),
            },
          ],
        };
      case 'session.tool.progress': {
        const call = calls.get(event.callID);

        if (!call) return { chunks: [] };

        return {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: event.callID,
              toolName: call.name,
              input: call.input,
              dynamic: true,
              toolMetadata: event.metadata,
            },
          ],
        };
      }

      case 'session.tool.success':
        return {
          chunks: [
            {
              type: 'tool-output-available',
              toolCallId: event.callID,
              output: toolOutput(event.output, event.content),
              dynamic: true,
            },
          ],
        };
      case 'session.tool.failed':
        if (isDenial(event.error)) {
          return {
            chunks: [
              { type: 'tool-approval-request', approvalId: event.callID, toolCallId: event.callID },
              {
                type: 'tool-approval-response',
                approvalId: event.callID,
                approved: false,
                reason: event.error.message,
              },
              { type: 'tool-output-denied', toolCallId: event.callID },
            ],
          };
        }

        return {
          chunks: [
            {
              type: 'tool-output-error',
              toolCallId: event.callID,
              errorText: event.error.message,
              dynamic: true,
            },
          ],
        };
      case 'session.compaction.started':
        reasons.set(event.messageID, event.reason);

        return compaction(event.messageID, { status: 'running' });
      case 'session.compaction.ended':
        return compaction(event.messageID, {
          status: 'completed',
          summary: event.summary,
          ...tokensOf(event.tokens),
        });
      case 'session.compaction.failed':
        failure = CHAT_FULL;

        return compaction(event.messageID, {
          status: 'failed',
          error: event.error.message,
          ...tokensOf(event.tokens),
        });
      case 'session.idle': {
        const closing = end();

        if (event.outcome === 'succeeded') {
          return { chunks: [...closing, { type: 'finish' }], done: true };
        }

        if (event.outcome === 'interrupted') {
          return { chunks: [...closing, { type: 'abort' }], done: true };
        }

        return {
          chunks: [...closing, { type: 'error', errorText: failure ?? 'The turn failed.' }],
          done: true,
        };
      }

      case 'session.deleted':
        return { chunks: [{ type: 'abort' }], done: true };
      default:
        return { chunks: [] };
    }
  };

  return Object.assign(map, { steered: () => steered });
}

/**
 * `useChat`'s transport over the local engine, shaped like the AI SDK's `DirectChatTransport`:
 * `sendMessages` follows the session's log from its head, prompts, and streams the turn that
 * prompt starts. Nothing resumes; closing the panel ends the turn (D8).
 */
export function createSessionTransport(options: SessionTransportOptions): ChatTransport<UIMessage> {
  const { engine, chat, request } = options;

  const session = async (ref: string | undefined) => {
    const known = request().chatId;

    if (known !== undefined) return String(known);

    if (!ref) throw new Error('Pick a model first.');

    const mode = options.mode?.();
    const created = await engine.create({ model: ref, ...(mode ? { mode } : {}) });

    await chat.open(created.id);
    options.onChatId(created.id);

    return created.id;
  };

  const sendMessages = async ({ trigger, messageId, messages, abortSignal }: Send) => {
    const ref = modelRef(request());
    const sessionID = await session(ref);
    const mode = options.mode?.();
    const user = messages.findLast((message) => message.role === 'user');

    if (!user) throw new Error('No message to send.');

    const from =
      trigger === 'regenerate-message' ? user.id : messageId === user.id ? messageId : undefined;

    const follow = new AbortController();

    options.onStreaming?.(sessionID, true, false);

    const after = await engine.head(sessionID);
    const log = engine.log({ sessionID, after, follow: true, signal: follow.signal });
    const first = log.next();
    const { messageID } = await engine
      .prompt({
        sessionID,
        messageID: user.id,
        parts: fromUIParts(user.parts),
        ...(from ? { from } : {}),
        ...(ref ? { model: ref } : {}),
        ...(mode ? { mode } : {}),
      })
      .catch((error: unknown) => {
        follow.abort();
        options.onStreaming?.(sessionID, false, false);

        throw error;
      });

    const queued =
      engine.queued(sessionID).some((entry) => entry.messageID === messageID) &&
      (await options.heldElsewhere(sessionID));

    const map = chunker();
    let settled = false;
    let waited = false;

    const settle = () => {
      if (settled) return;

      settled = true;
      follow.abort();
      options.onRetry?.(sessionID, undefined);
      options.onStreaming?.(sessionID, false, queued || waited || map.steered());
    };

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let mine = false;
        let closed = false;

        const push = (chunks: readonly UIMessageChunk[]) => {
          if (closed) return;

          for (const chunk of chunks) controller.enqueue(chunk);
        };

        const close = (chunks: readonly UIMessageChunk[] = []) => {
          push(chunks);

          if (closed) return;

          closed = true;
          controller.close();
          settle();
        };

        const stop = () => {
          if (engine.cancel(sessionID, messageID)) close([{ type: 'abort' }]);
          else engine.abort(sessionID);
        };

        if (queued) {
          push([{ type: 'data-queued', data: { messageId: messageID }, transient: true }]);
        }

        if (abortSignal?.aborted) stop();
        else abortSignal?.addEventListener('abort', stop, { once: true });

        const pump = async () => {
          for (let next = await first; !next.done && !closed; next = await log.next()) {
            const event = next.value;

            if (event.type === 'session.deleted') return close([{ type: 'abort' }]);

            if (!mine) {
              mine = event.type === 'session.prompted' && event.messageID === messageID;
              waited ||= event.type === 'session.idle';
              continue;
            }

            if (event.type === 'session.retry.scheduled') {
              options.onRetry?.(sessionID, { attempt: event.attempt, at: event.at });
            } else if (event.type === 'session.step.started') {
              options.onRetry?.(sessionID, undefined);
            }

            const { chunks, done } = map(event);

            if (done) return close(chunks);

            push(chunks);
          }

          close();
        };

        void pump().catch((error: unknown) => {
          if (!closed) {
            closed = true;
            controller.error(error);
          }

          settle();
        });
      },
      cancel: settle,
    });
  };

  return {
    sendMessages,
    reconnectToStream: () => Promise.resolve(null),
  };
}
