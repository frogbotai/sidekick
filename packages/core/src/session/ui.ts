import type { DynamicToolUIPart, UIMessage, UIMessagePart, UITools } from 'ai';

import type { AssistantContent, AssistantTool, SessionMessage, UserPart } from './schema';

/** `@frogbotai/ui`'s pasted-text part data. */
export interface PasteData {
  text: string;
  filename: string;
}

export interface SessionDataParts {
  [name: string]: unknown;
  paste: PasteData;
}

/** `@frogbotai/ui`'s attachment part, which the AI SDK's part union doesn't have. */
export interface FileReferenceUIPart {
  type: 'file-reference';
  id: string | number;
  filename: string;
  mediaType: string;
  origin?: 'paste';
}

export type SessionUIPart = UIMessagePart<SessionDataParts, UITools> | FileReferenceUIPart;

/** A `UIMessage` whose parts may include `file-reference`. */
export interface SessionUIMessage extends Omit<UIMessage<unknown, SessionDataParts>, 'parts'> {
  parts: SessionUIPart[];
}

function userPart(part: UserPart): SessionUIPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'file':
      return {
        type: 'file',
        mediaType: part.mediaType,
        url: part.url,
        ...(part.filename ? { filename: part.filename } : {}),
      };
    case 'file-reference':
      return part;
    case 'data-paste':
      return { type: 'data-paste', data: part.data };
  }
}

function toolPart(tool: AssistantTool): DynamicToolUIPart {
  const common = {
    type: 'dynamic-tool' as const,
    toolName: tool.name,
    toolCallId: tool.id,
    ...(tool.providerState ? { callProviderMetadata: tool.providerState } : {}),
  };

  switch (tool.state.status) {
    case 'streaming':
      return { ...common, state: 'input-streaming', input: undefined, rawInput: tool.state.input };
    case 'running':
      return { ...common, state: 'input-available', input: tool.state.input };
    case 'completed':
      return {
        ...common,
        state: 'output-available',
        input: tool.state.input,
        output: tool.state.output,
      };
    case 'error':
      return {
        ...common,
        state: 'output-error',
        input: tool.state.input,
        errorText: tool.state.error.message,
      };
  }
}

function assistantPart(part: AssistantContent): SessionUIPart {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text,
        state: 'done',
        ...(part.state ? { providerMetadata: part.state } : {}),
      };
    case 'reasoning':
      return {
        type: 'reasoning',
        id: part.id,
        text: part.text,
        state: 'done',
        ...(part.state ? { providerMetadata: part.state } : {}),
      };
    case 'tool':
      return toolPart(part);
  }
}

/**
 * A session's messages as AI SDK `UIMessage`s for `@frogbotai/ui`. A user message keeps its id; a
 * turn's assistant steps join into one message with the first step's id, each opening with
 * `step-start`, and tool parts keep their call ids. Other message kinds don't render.
 */
export function toUIMessages(messages: readonly SessionMessage[]): SessionUIMessage[] {
  const result: SessionUIMessage[] = [];
  let turn: SessionUIMessage | undefined;

  for (const message of messages) {
    if (message.type === 'user') {
      turn = undefined;
      result.push({ id: message.id, role: 'user', parts: message.parts.map(userPart) });
      continue;
    }

    if (message.type !== 'assistant') continue;

    if (!turn) {
      turn = { id: message.id, role: 'assistant', parts: [] };
      result.push(turn);
    }

    turn.parts.push({ type: 'step-start' }, ...message.content.map(assistantPart));
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fromUIPart(part: unknown): UserPart[] {
  if (!isRecord(part)) return [];

  const { type } = part;

  if (type === 'text' && typeof part.text === 'string') return [{ type, text: part.text }];

  if (type === 'file' && typeof part.url === 'string' && typeof part.mediaType === 'string') {
    return [
      {
        type,
        url: part.url,
        mediaType: part.mediaType,
        ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
      },
    ];
  }

  if (
    type === 'file-reference' &&
    (typeof part.id === 'string' || typeof part.id === 'number') &&
    typeof part.filename === 'string' &&
    typeof part.mediaType === 'string'
  ) {
    return [
      {
        type,
        id: part.id,
        filename: part.filename,
        mediaType: part.mediaType,
        ...(part.origin === 'paste' ? { origin: 'paste' as const } : {}),
      },
    ];
  }

  const { data } = part;

  if (type === 'data-paste' && isRecord(data)) {
    const { text, filename } = data;

    if (typeof text === 'string' && typeof filename === 'string') {
      return [{ type, data: { text, filename } }];
    }
  }

  return [];
}

/** A UI user message's parts as stored user parts; anything else is dropped. */
export function fromUIParts(parts: readonly unknown[]): UserPart[] {
  return parts.flatMap(fromUIPart);
}
