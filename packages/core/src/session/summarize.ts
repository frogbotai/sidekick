import { type LanguageModel, type ModelMessage, streamText, type ToolResultPart } from 'ai';

import type { ModelLimit } from '../provider/definition';
import {
  addUsage,
  COMPACTION_INTERRUPTED,
  estimateSize,
  estimateTokens,
  NOTHING_TO_COMPACT,
  oldestToDrop,
  previousCheckpoint,
  type RequestShape,
  requestTokens,
  SHRINK_STEPS,
  split,
  SUMMARY_OUTPUT_MAX,
  summaryBudget,
  truncateOutput,
} from './compaction';
import { buildPrompt, COMPACTION_PROMPT, fillsTemplate, NUDGE } from './compaction-prompt';
import { buildRequest, checkpointMessage, type ReasoningPolicy } from './request';
import { classify, MAX_RETRIES, retryDelay, sessionError } from './retry';
import type { CompactionCompleted, SessionError, TokenUsage } from './schema';
import { toolSet, usageOf } from './step';
import type { SessionStore } from './store';

class Unusable extends Error {}

/** The model a compaction runs on: the session's, with its known window. */
export interface CompactionModel {
  ref: string;
  language: LanguageModel;
  reasoning: ReasoningPolicy;
  limit?: ModelLimit;
}

export interface CompactInput extends RequestShape {
  store: SessionStore;
  sessionID: string;
  /** The compaction message's id. */
  messageID: string;
  reason: 'auto' | 'manual';
  model: CompactionModel;
  /** The `compaction` agent's prompt; overrides replace v2's. */
  prompt?: string;
  keep: number;
  buffer?: number;
  /** The provider just rejected the request as too long, so the first attempt aims below it. */
  overflow?: boolean;
  signal: AbortSignal;
  clock: {
    now: () => number;
    random: () => number;
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  };
}

export type CompactOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: SessionError }
  | { status: 'aborted' }
  | { status: 'empty' };

/** How a manual compaction ended. */
export type CompactResult = { status: 'completed' } | { status: 'failed'; error: SessionError };

/** A manual compaction's outcome as the caller sees it: nothing to compact, or aborted, fails. */
export function manualResult(outcome: CompactOutcome): CompactResult {
  switch (outcome.status) {
    case 'completed':
    case 'failed':
      return outcome;
    case 'empty':
      return { status: 'failed', error: { type: 'compaction', message: NOTHING_TO_COMPACT } };
    case 'aborted':
      return { status: 'failed', error: { type: 'aborted', message: COMPACTION_INTERRUPTED } };
  }
}

function exchangeStart(message: ModelMessage) {
  return (
    message.role === 'user' &&
    (typeof message.content === 'string' || message.content.some(({ type }) => type === 'text'))
  );
}

function resultText(output: ToolResultPart['output']) {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'content':
      return output.value.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    case 'execution-denied':
      return output.reason ?? '';
    default:
      return JSON.stringify(output.value) ?? '';
  }
}

function flattenMessage(message: ModelMessage) {
  if (message.role === 'system') return '';

  const label = message.role === 'user' ? 'User' : 'Assistant';

  if (typeof message.content === 'string') {
    return message.content ? `[${label}]: ${message.content}` : '';
  }

  const lines: string[] = [];

  for (const part of message.content) {
    if (part.type === 'text' && part.text) lines.push(`[${label}]: ${part.text}`);
    else if (part.type === 'image') lines.push('[image omitted]');
    else if (part.type === 'file') lines.push(`[${part.mediaType} omitted]`);
    else if (part.type === 'tool-call') {
      lines.push(`[Assistant tool call]: ${part.toolName}(${JSON.stringify(part.input) ?? ''})`);
    } else if (part.type === 'tool-result') {
      const failed = part.output.type === 'error-text' || part.output.type === 'error-json';

      lines.push(
        `[${failed ? 'Tool error' : 'Tool result'}]: ${truncateOutput(resultText(part.output))}`,
      );
    }
  }

  return lines.join('\n');
}

const omitted = (count: number) =>
  count ? `[${count} older ${count === 1 ? 'exchange' : 'exchanges'} omitted]\n\n` : '';

function flattenAndDropOldest(
  request: readonly ModelMessage[],
  previous: CompactionCompleted | undefined,
  shape: RequestShape,
  target: number,
): ModelMessage[] | undefined {
  const lead = previous ? [checkpointMessage(previous.summary, '')] : [];
  const rest = previous ? request.slice(1) : request;

  const exchanges = rest.reduce<string[]>(
    (groups, message) => {
      const text = flattenMessage(message);

      if (!text) return groups;

      if (exchangeStart(message) || groups.length === 0) groups.push(text);
      else groups[groups.length - 1] += `\n${text}`;

      return groups;
    },
    previous?.recent ? [previous.recent] : [],
  );

  const room = target - requestTokens(shape, lead) - estimateTokens(omitted(exchanges.length));

  const kept = exchanges.slice(oldestToDrop(exchanges, (text) => estimateTokens(text) + 1, room));

  if (kept.length === 0) return undefined;

  return [
    ...lead,
    { role: 'user', content: omitted(exchanges.length - kept.length) + kept.join('\n\n') },
  ];
}

interface Spent {
  tokens?: TokenUsage;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

async function summaryCall(input: CompactInput, messages: ModelMessage[], spent: Spent) {
  const output = Math.min(input.model.limit?.output ?? SUMMARY_OUTPUT_MAX, SUMMARY_OUTPUT_MAX);
  let text = '';
  let finish: string | undefined;
  let error: unknown;

  const result = streamText({
    model: input.model.language,
    ...(input.system ? { system: input.system } : {}),
    messages,
    tools: toolSet(input.tools),
    maxOutputTokens: output,
    abortSignal: input.signal,
    maxRetries: 0,
  });

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text;
    else if (part.type === 'finish-step') {
      finish = part.finishReason;
      spent.tokens = addUsage(spent.tokens, usageOf(part.usage));
    } else if (part.type === 'error') error = part.error;
  }

  if (error !== undefined) throw asError(error);

  if (finish === 'length') throw new Unusable('Compaction summary reached the output token limit');

  if (finish === 'content-filter') {
    throw new Unusable('Compaction summary was blocked by the provider');
  }

  return text;
}

async function summarize(input: CompactInput, until: string | undefined, spent: Spent) {
  const { model, clock, signal } = input;
  const messages = await input.store.messages(input.sessionID);
  const previous = previousCheckpoint(messages);
  const system = input.prompt ?? COMPACTION_PROMPT;
  const prompt = buildPrompt(previous !== undefined, system);
  const request = buildRequest({
    messages,
    reasoning: model.reasoning,
    ...(until ? { until } : {}),
  });

  const size = estimateSize({ ...input, messages, model: model.ref, reasoning: model.reasoning });

  let target =
    summaryBudget(
      model.limit,
      input.buffer,
      input.overflow ? size.measured + size.estimated : undefined,
    ) -
    estimateTokens(prompt) -
    estimateTokens(NUDGE);

  let rejections = 0;
  let rejected: number | undefined;
  let retries = 0;

  const send = async (sent: ModelMessage[]) => {
    const prompted: ModelMessage[] = [...sent, { role: 'user', content: prompt }];
    const first = await summaryCall(input, prompted, spent);

    if (fillsTemplate(first, system)) return first;

    const again = await summaryCall(input, [...prompted, { role: 'user', content: NUDGE }], spent);

    if (fillsTemplate(again, system)) return again;

    throw new Unusable(
      again.trim()
        ? 'Compaction summary did not match the required template'
        : 'Compaction produced no summary',
    );
  };

  for (;;) {
    const fits = requestTokens(input, request) <= target;
    const sent = fits
      ? request
      : (flattenAndDropOldest(request, previous, input, target) ??
        (rejections > 0 ? undefined : request));

    if (!sent) {
      throw new Unusable(
        'The compaction request cannot be reduced further without losing the latest exchange or checkpoint',
      );
    }

    try {
      return (await send(sent)).trim();
    } catch (error) {
      if (error instanceof Unusable || signal.aborted) throw asError(error);

      const verdict = classify(error);

      if (verdict === 'overflow') {
        const step = SHRINK_STEPS[rejections];

        if (step === undefined) throw asError(error);

        rejected ??= requestTokens(input, sent);
        target = Math.floor(rejected * step);
        rejections++;
        continue;
      }

      if (verdict !== 'retry' || retries >= MAX_RETRIES) throw asError(error);

      retries++;
      await clock.sleep(retryDelay(retries, error, clock.random, clock.now()), signal);
    }
  }
}

function failure(error: unknown): SessionError {
  if (error instanceof Unusable) return { type: 'compaction', message: error.message };

  return sessionError(error);
}

/**
 * Compacts a session, after v2's `SessionCompaction.compact`: writes a running compaction, then
 * completes it with the summary and the verbatim recent tail, or fails it. With nothing to
 * compact it writes nothing.
 */
export async function compact(input: CompactInput): Promise<CompactOutcome> {
  const { store, sessionID, messageID } = input;
  const parts = split(await store.messages(sessionID), input.keep);

  if (!parts) return { status: 'empty' };

  await store.publish(sessionID, {
    type: 'session.compaction.started',
    messageID,
    reason: input.reason,
  });

  const spent: Spent = {};

  try {
    const summary = await summarize(input, parts.until, spent);

    await store.publish(sessionID, {
      type: 'session.compaction.ended',
      messageID,
      summary,
      recent: parts.recent,
      model: input.model.ref,
      ...(spent.tokens ? { tokens: spent.tokens } : {}),
    });

    return { status: 'completed' };
  } catch (caught) {
    const { tokens } = spent;
    const aborted = input.signal.aborted;
    const error: SessionError = aborted
      ? { type: 'aborted', message: COMPACTION_INTERRUPTED }
      : failure(caught);

    await store.publish(sessionID, {
      type: 'session.compaction.failed',
      messageID,
      error,
      ...(tokens ? { tokens } : {}),
    });

    return aborted ? { status: 'aborted' } : { status: 'failed', error };
  }
}
