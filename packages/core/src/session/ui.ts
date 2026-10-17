import type { DynamicToolUIPart, UIMessage, UIMessagePart, UITools } from 'ai';

import type { ToolContent } from '../tool/tool';
import type {
  AssistantContent,
  AssistantTool,
  CompactionMessage,
  SessionMessage,
  TokenUsage,
  ToolFailure,
  UserPart,
} from './schema';

/** `@frogbotai/ui`'s pasted-text part data. */
export interface PasteData {
  text: string;
  filename: string;
}

/** `@frogbotai/ui`'s `CompactionPartData`: `tokens` are the summary call's own totals. */
export interface CompactionData {
  status: CompactionMessage['status'];
  reason: CompactionMessage['reason'];
  summary?: string;
  error?: string;
  tokens?: { input: number; output: number };
}

export interface SessionDataParts {
  [name: string]: unknown;
  paste: PasteData;
  compaction: CompactionData;
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

/** A message's stored time, in ms, which `@frogbotai/ui` shows. */
export interface SessionUIMetadata {
  createdAt: number;
}

/** A `UIMessage` whose parts may include `file-reference`. */
export interface SessionUIMessage extends Omit<
  UIMessage<SessionUIMetadata, SessionDataParts>,
  'parts'
> {
  parts: SessionUIPart[];
}

/** A tool result's extra content in MCP's shapes, which `@frogbotai/ui`'s tool display reads. */
export type ToolUIContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType: string };

/** A tool result that carried content, MCP-style: the output's fields beside `content`. */
export type ToolUIOutput = Record<string, unknown> & { content: ToolUIContent[] };

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function contentPart(part: ToolContent): ToolUIContent {
  if (part.type === 'text') return part;

  const image = DATA_URI.exec(part.uri);

  if (image?.[1]?.startsWith('image/') && image[2] !== undefined) {
    return { type: 'image', data: image[2], mimeType: image[1] };
  }

  return { type: 'resource_link', uri: part.uri, name: part.name ?? part.uri, mimeType: part.mime };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A tool result as the UI part's `output`, the same live and reloaded. With content, such as a
 * screenshot, it is MCP's `{ ...fields, content }`; an output that isn't a plain object, or that
 * has its own `content`, sits under `output`.
 */
export function toolOutput(output: unknown, content?: readonly ToolContent[]): unknown {
  if (!content?.length) return output;

  const parts = content.map(contentPart);
  const result: ToolUIOutput =
    isRecord(output) && !('content' in output)
      ? { ...output, content: parts }
      : { output, content: parts };

  return result;
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

/** Stored user parts as UI parts, as `toUIMessages` gives them. */
export function userUIParts(parts: readonly UserPart[]): SessionUIPart[] {
  return parts.map(userPart);
}

/** Whether a tool failed because the user or a rule said no, which the UI shows as `output-denied`. */
export function isDenial(error: ToolFailure) {
  return error.code === 'denied' || error.code === 'declined';
}

function toolPart(tool: AssistantTool): DynamicToolUIPart {
  const common = {
    type: 'dynamic-tool' as const,
    toolName: tool.name,
    toolCallId: tool.id,
    ...(tool.providerState ? { callProviderMetadata: tool.providerState } : {}),
    ...(tool.metadata ? { toolMetadata: tool.metadata } : {}),
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
        output: toolOutput(tool.state.output, tool.state.content),
      };
    case 'error':
      if (isDenial(tool.state.error)) {
        return {
          ...common,
          state: 'output-denied',
          input: tool.state.input,
          approval: { id: tool.id, approved: false, reason: tool.state.error.message },
        };
      }

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
 * turn's assistant steps and compactions join into one message with the first one's id, each step
 * opening with `step-start`, each compaction a `data-compaction` part with its own id, and tool
 * parts keep their call ids. A compaction outside a turn opens its own message. Each carries its
 * stored time as `metadata.createdAt`. Other message kinds don't render.
 */
export function toUIMessages(messages: readonly SessionMessage[]): SessionUIMessage[] {
  const result: SessionUIMessage[] = [];
  let turn: SessionUIMessage | undefined;

  for (const message of messages) {
    if (message.type === 'user') {
      turn = undefined;

      result.push({
        id: message.id,
        role: 'user',
        metadata: { createdAt: message.time.created },
        parts: userUIParts(message.parts),
      });

      continue;
    }

    if (message.type === 'idle') turn = undefined;

    if (message.type !== 'assistant' && message.type !== 'compaction') continue;

    if (!turn) {
      turn = {
        id: message.id,
        role: 'assistant',
        metadata: { createdAt: message.time.created },
        parts: [],
      };

      result.push(turn);
    }

    if (message.type === 'compaction') {
      turn.parts.push({ type: 'data-compaction', id: message.id, data: compactionData(message) });
    } else {
      turn.parts.push({ type: 'step-start' }, ...message.content.map(assistantPart));
    }
  }

  return result;
}

function compactionTokens(tokens: TokenUsage | undefined) {
  return tokens ? { tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0 } } : {};
}

/** A compaction message, or its events so far, as the `data-compaction` part's data. */
export function compactionData(message: CompactionMessage): CompactionData {
  const { status, reason } = message;

  switch (message.status) {
    case 'running':
      return { status, reason };
    case 'completed':
      return { status, reason, summary: message.summary, ...compactionTokens(message.tokens) };
    case 'failed':
      return { status, reason, error: message.error.message, ...compactionTokens(message.tokens) };
  }
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
