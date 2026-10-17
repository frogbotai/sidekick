import type { ModelMessage, ToolResultPart } from 'ai';
import { z } from 'zod';

import type { ModelLimit } from '../provider/definition';
import type { ToolDefinition } from '../tool/tool';
import { type ReasoningPolicy, requestGroups, sinceCheckpoint } from './request';
import type {
  AssistantMessage,
  AssistantTool,
  CompactionCompleted,
  SessionMessage,
  TokenUsage,
  UserPart,
} from './schema';

/** v2's compaction settings: `buffer` is the room kept free below the window; `keep` the verbatim tail. */
export interface CompactionSettings {
  auto?: boolean;
  buffer?: number;
  keep?: number;
}

export const COMPACTION_DEFAULTS = { auto: true, keep: 15_000 } as const;

export const NOTHING_TO_COMPACT = 'Nothing to compact yet';

export const COMPACTION_INTERRUPTED = 'Compaction was interrupted';

const FIRST_SHRINK = 0.7;

/** After each "too long" rejection, the next attempt aims at this share of the first rejected size. */
export const SHRINK_STEPS = [FIRST_SHRINK, 0.5, 0.35] as const;

export const RESERVE_MIN = 16_000;

/** A common window, assumed for the summary request when the model's is unknown. */
export const UNKNOWN_WINDOW = 200_000;

export const TOOL_OUTPUT_MAX_CHARS = 1_250;

export const IMAGE_TOKENS = 1_500;

const PDF_TOKENS = 2_000;

export const SUMMARY_OUTPUT_MAX = 32_000;

/** v2's `Token.estimate`: four characters a token. */
export function estimateTokens(text: string) {
  return Math.max(0, Math.round(text.length / 4));
}

/**
 * The largest request the model takes while leaving room for its reply, after v2's
 * `calculateCeiling`: 10% of the window or 16k, whichever is more (16k only from a 32k window).
 * An unknown window is `Infinity`, so it never compacts on its own.
 */
export function ceiling(limit: Partial<ModelLimit> | undefined, buffer?: number) {
  const window = limit?.input ? limit.input : (limit?.context ?? 0);

  if (window <= 0) return Number.POSITIVE_INFINITY;

  if (buffer !== undefined) return window - buffer;

  return window - Math.max(Math.floor(window * 0.1), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0);
}

/** What a summary request may send: the ceiling, 200k assumed when unknown, else 70% of a rejected size. */
export function summaryBudget(
  limit: Partial<ModelLimit> | undefined,
  buffer: number | undefined,
  rejected?: number,
) {
  const top = ceiling(limit, buffer);
  const cap = Number.isFinite(top) ? top : ceiling({ context: UNKNOWN_WINDOW }, buffer);

  return rejected === undefined ? cap : Math.min(cap, Math.floor(rejected * FIRST_SHRINK));
}

function mediaTokens(mediaType: string) {
  const type = mediaType.toLowerCase();

  if (type.startsWith('image')) return IMAGE_TOKENS;

  return type === 'application/pdf' ? PDF_TOKENS : 0;
}

function outputTokens(output: ToolResultPart['output']): number {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return estimateTokens(output.value);
    case 'json':
    case 'error-json':
      return estimateTokens(JSON.stringify(output.value) ?? '');
    case 'execution-denied':
      return estimateTokens(output.reason ?? '');
    case 'content':
      return output.value.reduce(
        (sum, item) =>
          sum +
          (item.type === 'text'
            ? estimateTokens(item.text)
            : 'mediaType' in item
              ? mediaTokens(String(item.mediaType))
              : 0),
        0,
      );
    default:
      return 0;
  }
}

type RequestPart = Exclude<ModelMessage['content'], string>[number];

function partTokens(part: RequestPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return estimateTokens(part.text);
    case 'image':
      return IMAGE_TOKENS;
    case 'file':
      return mediaTokens(part.mediaType);
    case 'tool-call':
      return estimateTokens(part.toolName + (JSON.stringify(part.input) ?? ''));
    case 'tool-result':
      return outputTokens(part.output);
    default:
      return 0;
  }
}

/** One request message's estimated size: text by length, 1,500 per image, tool JSON by length. */
export function messageTokens(message: ModelMessage) {
  if (typeof message.content === 'string') return estimateTokens(message.content);

  let sum = 0;

  for (const part of message.content) sum += partTokens(part);

  return sum;
}

function schemaText(tool: ToolDefinition) {
  try {
    return JSON.stringify(z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return '';
  }
}

/** What a request sends besides its messages. */
export interface RequestShape {
  system?: string;
  tools: readonly ToolDefinition[];
}

/** A whole request's estimated size: system prompt, tool schemas and messages. */
export function requestTokens(shape: RequestShape, messages: readonly ModelMessage[]) {
  return (
    estimateTokens(shape.system ?? '') +
    shape.tools.reduce(
      (sum, tool) => sum + estimateTokens(tool.id + tool.description + schemaText(tool)),
      0,
    ) +
    messages.reduce((sum, message) => sum + messageTokens(message), 0)
  );
}

const baseRef = (ref: string) => ref.split('#')[0] ?? ref;

function measures(message: SessionMessage, model: string): message is AssistantMessage {
  return (
    message.type === 'assistant' &&
    baseRef(message.model) === baseRef(model) &&
    !message.error &&
    (message.tokens?.input ?? 0) > 0
  );
}

export interface SizeInput extends RequestShape {
  messages: readonly SessionMessage[];
  model: string;
  reasoning: ReasoningPolicy;
}

/**
 * The next request's size, after v2's `estimatePrompt`. `measured` is the latest anchor's own
 * input and output (AI SDK totals, so cache is already in); `estimated` is chars/4 of what the
 * request adds after it, the anchor's tool results included. With no anchor it is all estimated.
 */
export function estimateSize(input: SizeInput) {
  const groups = requestGroups({ messages: input.messages, reasoning: input.reasoning });
  const at = groups.findLastIndex(({ message }) => measures(message, input.model));
  const anchor = groups[at]?.message;

  if (!anchor || !measures(anchor, input.model)) {
    return {
      measured: 0,
      estimated: requestTokens(
        input,
        groups.flatMap(({ messages }) => messages),
      ),
    };
  }

  const after = groups
    .slice(at)
    .flatMap(({ messages }, index) =>
      index === 0 ? messages.filter(({ role }) => role !== 'assistant') : messages,
    );

  return {
    measured: (anchor.tokens?.input ?? 0) + (anchor.tokens?.output ?? 0),
    estimated: after.reduce((sum, message) => sum + messageTokens(message), 0),
  };
}

function isCheckpoint(message: SessionMessage | undefined): message is CompactionCompleted {
  return message?.type === 'compaction' && message.status === 'completed';
}

/**
 * Whether the next step should compact first, after v2's `due`: never straight after a
 * compaction, nor before a step has measured the compacted request.
 */
export function due(input: SizeInput & { ceiling: number }) {
  const view = sinceCheckpoint(input.messages);

  if (isCheckpoint(view.at(-1))) return false;

  if (isCheckpoint(view[0]) && !view.some((message) => measures(message, input.model))) {
    return false;
  }

  const size = estimateSize(input);

  return size.measured + size.estimated >= input.ceiling;
}

/** Cuts long tool output to 1,250 code points, never splitting a surrogate pair. */
export function truncateOutput(value: string) {
  const chars = [...value];

  if (chars.length <= TOOL_OUTPUT_MAX_CHARS) return value;

  return `${chars.slice(0, TOOL_OUTPUT_MAX_CHARS).join('')}\n[truncated]`;
}

function toolText(tool: AssistantTool) {
  const { state } = tool;
  const input = typeof state.input === 'string' ? state.input : JSON.stringify(state.input);
  const call = `[Assistant tool call]: ${tool.name}(${input ?? ''})`;

  if (state.status === 'completed') {
    const parts = [
      JSON.stringify(state.output ?? null),
      ...(state.content ?? []).map((item) =>
        item.type === 'text'
          ? item.text
          : `[Attached ${item.mime}${item.name === undefined ? '' : `: ${item.name}`}]`,
      ),
    ];

    return [call, `[Tool result]: ${truncateOutput(parts.join('\n'))}`];
  }

  if (state.status === 'error') return [call, `[Tool error]: ${state.error.message}`];

  return [call];
}

function userText(parts: readonly UserPart[]) {
  const texts: string[] = [];
  const files: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'data-paste') texts.push(part.data.text);
    else if (part.type === 'file') {
      files.push(`[Attached ${part.mediaType}: ${part.filename ?? 'inline attachment'}]`);
    } else files.push(`[Attached ${part.mediaType}: ${part.filename}]`);
  }

  return [`[User]: ${texts.join('\n')}`, ...files].join('\n');
}

/** One message as the verbatim recent part shows it, after v2's `messageToText`; empty to leave out. */
export function messageToText(message: SessionMessage): string {
  switch (message.type) {
    case 'user':
      return userText(message.parts);
    case 'synthetic':
      return `[Synthetic context]: ${message.text}`;
    case 'assistant':
      return message.content
        .flatMap((part) => {
          if (part.type === 'text') return part.text ? [`[Assistant]: ${part.text}`] : [];

          if (part.type === 'reasoning') {
            return part.text ? [`[Assistant reasoning]: ${part.text}`] : [];
          }

          return toolText(part);
        })
        .join('\n');
    default:
      return '';
  }
}

/** How many of the oldest items to drop so the rest fit `budget`, newest first. */
export function oldestToDrop<T>(items: readonly T[], size: (item: T) => number, budget: number) {
  let total = 0;
  let start = items.length;

  while (start > 0) {
    const item = items[start - 1];
    const next = total + (item === undefined ? 0 : size(item));

    if (next > budget) break;

    total = next;
    start--;
  }

  return start;
}

interface TextEntry {
  message: SessionMessage;
  text: string;
  index: number;
}

function recentStart(entries: readonly TextEntry[], keep: number, previous?: CompactionCompleted) {
  const dropped = Math.min(
    oldestToDrop(entries, (entry) => estimateTokens(entry.text), keep),
    entries.length - 1,
  );

  const boundary = entries.findLastIndex(
    (entry, index) => index <= dropped && entry.message.type === 'user',
  );

  if (boundary > 0) return boundary;

  const latestUser = entries.findLastIndex((entry) => entry.message.type === 'user');

  if (latestUser > 0) return latestUser;

  return previous?.recent ? 0 : entries.length;
}

/** The latest checkpoint, when the history since it starts with one. */
export function previousCheckpoint(messages: readonly SessionMessage[]) {
  const [first] = sinceCheckpoint(messages);

  return isCheckpoint(first) ? first : undefined;
}

export interface Split {
  /** What gets summarized: the previous checkpoint, if any, and the messages before `recent`. */
  older: SessionMessage[];
  /** The newest messages within `keep` tokens, as text. */
  recent: string;
  /** The first message `recent` holds, where the summary request stops. */
  until?: string;
}

/**
 * Splits the history since the latest checkpoint, after v2's `splitConversation`: the recent tail
 * starts at a user message, or, when everything fits, holds only the latest exchange. Undefined
 * when there is nothing to compact.
 */
export function split(messages: readonly SessionMessage[], keep: number): Split | undefined {
  const view = sinceCheckpoint(messages);

  const entries = view.flatMap((message, index) => {
    const text = messageToText(message);

    return text ? [{ message, text, index }] : [];
  });

  if (entries.length === 0) return undefined;

  const recent = entries.slice(recentStart(entries, keep, previousCheckpoint(messages)));
  const first = recent[0];

  return {
    older: view.slice(0, first?.index ?? view.length),
    recent: recent.map(({ text }) => text).join('\n\n'),
    ...(first ? { until: first.message.id } : {}),
  };
}

/** Two calls' usage, added. */
export function addUsage(total: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!total) return next;

  const sum = (key: keyof TokenUsage) =>
    total[key] === undefined && next[key] === undefined
      ? {}
      : { [key]: (total[key] ?? 0) + (next[key] ?? 0) };

  return {
    ...sum('input'),
    ...sum('output'),
    ...sum('reasoning'),
    ...sum('cacheRead'),
    ...sum('cacheWrite'),
  };
}
