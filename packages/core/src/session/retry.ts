import { AISDKError, APICallError } from 'ai';

import type { SessionError } from './schema';

/** v2's retry budget: 10 retries, exponential from 2 s, capped at 10 s per gap (`retry.ts`). */
export const MAX_RETRIES = 10;

export const RETRY_BASE_MS = 2_000;

export const RETRY_CAP_MS = 10_000;

/** A provider's `retry-after` is honoured up to this, so a bad header can't stall a chat for hours. */
export const RETRY_AFTER_MAX_MS = 15 * 60 * 1000;

export const CHAT_FULL = 'This chat is full. Start a new one.';

const OVERFLOW = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeded this model context window limit/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /number of input tokens exceeds maximum length/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /requested input length \d+ exceeds maximum input length/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input(?: \(\d+ tokens\))? is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /`inputs` tokens \+ `max_new_tokens` must be <= \d+/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt (?:too long|超长)/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /range of input length should be/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /request_too_large/i,
];

const NOT_OVERFLOW = [
  /^(throttling error|service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
  /max[_ ]tokens must be less than/i,
];

const QUOTA = /insufficient_quota|exceeded your current quota|billing/i;

const TRANSIENT =
  /overloaded|rate.?limit|too many requests|server_error|internal server error|unavailable/i;

/** What to do with a failed model call. */
export type Verdict = 'retry' | 'overflow' | 'fatal';

function textOf(error: unknown): string {
  if (APICallError.isInstance(error)) return `${error.message} ${error.responseBody ?? ''}`;

  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Whether a message says the request no longer fits the model, after v2's `isContextOverflow`. */
export function isContextOverflow(message: string) {
  return (
    !NOT_OVERFLOW.some((pattern) => pattern.test(message)) &&
    (OVERFLOW.some((pattern) => pattern.test(message)) ||
      /^4(?:00|13)\s*(status code)?\s*\(no body\)/i.test(message))
  );
}

/**
 * Sorts a failure the way v2's `isRetryable` does: rate limits, provider failures, transport
 * failures and unrecognised errors retry; auth, quota, bad requests and overflow don't.
 */
export function classify(error: unknown): Verdict {
  const text = textOf(error);

  if (isContextOverflow(text)) return 'overflow';

  if (APICallError.isInstance(error)) {
    const override = error.responseHeaders?.['x-should-retry'];

    if (override === 'true') return 'retry';

    if (override === 'false') return 'fatal';

    const status = error.statusCode;

    if (status === 429) return QUOTA.test(text) ? 'fatal' : 'retry';

    if (status !== undefined && status >= 500) return 'retry';

    if (status !== undefined) return 'fatal';

    return error.isRetryable ? 'retry' : 'fatal';
  }

  if (error instanceof TypeError) return 'retry';

  if (AISDKError.isInstance(error)) return TRANSIENT.test(text) ? 'retry' : 'fatal';

  return 'retry';
}

/** The provider's requested wait, from `retry-after-ms` or `retry-after` (seconds or a date). */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  if (!APICallError.isInstance(error)) return undefined;

  const headers = error.responseHeaders ?? {};
  const ms = Number(headers['retry-after-ms']);

  if (Number.isFinite(ms) && ms >= 0) return ms;

  const after = headers['retry-after'];

  if (after === undefined) return undefined;

  const seconds = Number(after);

  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(after);

  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The wait before retry `attempt` (from 1): jittered exponential, at least what the provider asked. */
export function retryDelay(
  attempt: number,
  error: unknown,
  random = Math.random,
  now = Date.now(),
) {
  const base = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
  const jittered = Math.ceil(base * (0.8 + random() * 0.4));
  const asked = retryAfterMs(error, now);

  return asked === undefined ? jittered : Math.max(jittered, Math.min(asked, RETRY_AFTER_MAX_MS));
}

/** A failure as stored on the assistant message. */
export function sessionError(error: unknown, verdict = classify(error)): SessionError {
  if (verdict === 'overflow') return { type: 'overflow', message: CHAT_FULL };

  const message =
    APICallError.isInstance(error) || error instanceof Error ? error.message : textOf(error);

  return { type: 'provider', message };
}
