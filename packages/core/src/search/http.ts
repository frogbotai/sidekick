import { privateFetch } from '../provider/fetch';

export const SEARCH_TIMEOUT_MS = 25_000;

export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** A search request answered with a non-2xx status. The message never names the URL. */
export class SearchHttpError extends Error {
  override readonly name = 'SearchHttpError';

  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(`Web search request failed (HTTP ${status})`);
  }
}

class TooLargeError extends Error {
  override readonly name = 'TooLargeError';
}

async function bounded(response: Response, label: string) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) return text + decoder.decode();

    size += value.byteLength;

    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);

      throw new TooLargeError(`${label} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    }

    text += decoder.decode(value, { stream: true });
  }
}

/**
 * Fetches a search endpoint and returns its body as text. Stops after 25 s or when `signal`
 * aborts, fails on a body over 1 MiB, and throws `SearchHttpError` on a non-2xx status. No error
 * it throws names the URL, so a key in the query string stays out of messages.
 */
export async function searchFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  label: string,
) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SEARCH_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout.signal]);

  try {
    const response = await privateFetch(url, { ...init, signal: combined });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);

      throw new SearchHttpError(response.status, response.headers.get('retry-after') ?? undefined);
    }

    return await bounded(response, label);
  } catch (error) {
    if (error instanceof SearchHttpError || error instanceof TooLargeError) throw error;

    if (signal.aborted) throw signal.reason;

    if (timeout.signal.aborted) throw new Error(`${label} request timed out`);

    throw new Error(`${label} request failed`);
  } finally {
    clearTimeout(timer);
  }
}
