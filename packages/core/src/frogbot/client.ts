import { APICallError } from 'ai';
import { z } from 'zod';

import { credentials } from '../provider/credentials';
import { providerMessage } from '../provider/errors';
import { privateFetch } from '../provider/fetch';

export const FROGBOT_URL = 'https://app.frogbot.ai';

export const FROGBOT_PROVIDER_ID = 'frogbot';

export const FROGBOT_BILLING_URL = `${FROGBOT_URL}/billing`;

/** Tags every FrogBot call, so Firmware's usage logs can tell Sidekick apart. */
export const FROGBOT_HEADERS: Readonly<Record<string, string>> = { 'x-frogbot-source': 'sidekick' };

/** Why a FrogBot call failed: no key, a refused key, no credit, or the per-minute limit. */
export type FrogbotErrorCode = 'not-connected' | 'reconnect' | 'credit' | 'rate-limited';

export interface FrogbotErrorInput {
  code: FrogbotErrorCode;
  url: string;
  statusCode?: number;
  responseHeaders?: Record<string, string>;
  balanceUSD?: number;
  retryAfterSeconds?: number;
}

function messageFor({ code, balanceUSD, retryAfterSeconds }: FrogbotErrorInput) {
  switch (code) {
    case 'not-connected':
      return 'FrogBot not connected';
    case 'reconnect':
      return 'FrogBot refused the key. Reconnect FrogBot.';
    case 'credit':
      return `Out of FrogBot credit${balanceUSD === undefined ? '' : ` (balance $${balanceUSD.toFixed(2)})`}. Top up at ${FROGBOT_BILLING_URL}`;
    case 'rate-limited':
      return `FrogBot's rate limit was reached. Retry after ${retryAfterSeconds ?? 60} s.`;
  }
}

/**
 * A FrogBot failure the user can act on. It is an `APICallError`, so AI SDK's retry still
 * honours `Retry-After` on a 429 from the chat route.
 */
export class FrogbotError extends APICallError {
  readonly code: FrogbotErrorCode;
  readonly balanceUSD?: number;
  readonly topUpURL?: string;
  readonly retryAfterSeconds?: number;

  constructor(input: FrogbotErrorInput) {
    super({
      message: messageFor(input),
      url: input.url,
      requestBodyValues: undefined,
      ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
      ...(input.responseHeaders ? { responseHeaders: input.responseHeaders } : {}),
      isRetryable: input.code === 'rate-limited',
    });

    this.code = input.code;

    if (input.balanceUSD !== undefined) this.balanceUSD = input.balanceUSD;

    if (input.code === 'credit') this.topUpURL = FROGBOT_BILLING_URL;

    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
  }

  static is(error: unknown): error is FrogbotError {
    return error instanceof FrogbotError;
  }
}

const Quota = z.object({ balanceUSD: z.number() });

export function apiURL(path: string) {
  return `${FROGBOT_URL}/api${path}`;
}

function authHeaders(key: string) {
  return { ...FROGBOT_HEADERS, Authorization: `Bearer ${key}` };
}

/** The connected FrogBot key, or `undefined`. */
export async function frogbotKey() {
  const credential = await credentials.active(FROGBOT_PROVIDER_ID);

  return credential?.value.type === 'key' ? credential.value.key : undefined;
}

/** Reads `balanceUSD` from `/api/v1/quota`, or `undefined` when it can't. Never throws. */
export async function readBalance(key: string, signal?: AbortSignal) {
  try {
    const response = await privateFetch(apiURL('/v1/quota'), {
      headers: authHeaders(key),
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) return;

    const parsed = Quota.safeParse(await response.json());

    return parsed.success ? parsed.data.balanceUSD : undefined;
  } catch {
    return;
  }
}

function retryAfter(headers: Headers | Record<string, string> | undefined) {
  const value = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  const seconds = value ? Number.parseFloat(value) : Number.NaN;

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function retryAfterIn(body: string | undefined) {
  try {
    const parsed = z
      .object({ retryAfterSeconds: z.number().nonnegative() })
      .safeParse(JSON.parse(body ?? ''));

    return parsed.success ? parsed.data.retryAfterSeconds : undefined;
  } catch {
    return;
  }
}

interface Failure {
  url: string;
  status: number;
  headers?: Headers | Record<string, string>;
  body?: string;
  key?: string;
}

/** The `FrogbotError` for a 401, 402 or 429, or `undefined` for any other status. */
export async function frogbotFailure({ url, status, headers, body, key }: Failure) {
  const responseHeaders =
    headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;

  const common = { url, statusCode: status, ...(responseHeaders ? { responseHeaders } : {}) };

  if (status === 401) return new FrogbotError({ ...common, code: 'reconnect' });

  if (status === 402) {
    const balanceUSD = key ? await readBalance(key) : undefined;

    return new FrogbotError({
      ...common,
      code: 'credit',
      ...(balanceUSD === undefined ? {} : { balanceUSD }),
    });
  }

  if (status === 429) {
    const retryAfterSeconds = retryAfter(headers) ?? retryAfterIn(body);

    return new FrogbotError({
      ...common,
      code: 'rate-limited',
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }

  return undefined;
}

export interface FrogbotFetchInit extends Omit<RequestInit, 'credentials' | 'headers'> {
  headers?: Record<string, string>;
  /** The key to send; the connected key when left out. */
  key?: string;
}

/**
 * Calls FrogBot's API at `path` (under `/api`) with the key read now, the Sidekick source header
 * and no cookies. Throws `FrogbotError` with no key and on 401, 402 and 429; other answers are returned.
 */
export async function frogbotFetch(path: string, { key, headers, ...init }: FrogbotFetchInit = {}) {
  const url = apiURL(path);
  const used = key ?? (await frogbotKey());

  if (!used) throw new FrogbotError({ code: 'not-connected', url });

  const response = await privateFetch(url, {
    ...init,
    headers: { ...headers, ...authHeaders(used) },
    credentials: 'omit',
  });

  if (response.ok) return response;

  const body = await response
    .clone()
    .text()
    .catch(() => '');

  const failure = await frogbotFailure({
    url,
    status: response.status,
    headers: response.headers,
    body,
    key: used,
  });

  if (failure) throw failure;

  return response;
}

/** The server's words for a failed answer, or its status. */
export async function frogbotMessage(response: Response) {
  const body = await response.text().catch(() => '');

  return providerMessage(body) ?? `FrogBot answered ${response.status}`;
}
