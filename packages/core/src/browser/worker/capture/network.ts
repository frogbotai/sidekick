import { race } from '../abort';
import { COMMAND_TIMEOUT_MS } from '../sessions';
import type { Cdp, CdpEvent } from '../types';
import { type CaptureBuffer, createBuffer, type Taken } from './buffer';
import {
  type BodyOmitted,
  type CapturedBody,
  type NetworkEntry,
  protectEntry,
  redactKnown,
} from './entry';
import type { Header, SecretRedactor } from './redact';

/** The largest body a capture keeps, as browse does; a larger one is kept out whole, never cut. */
export const MAX_BODY_BYTES = 1_000_000;

/** The most body text one capture keeps in all, as browse does. */
export const MAX_CAPTURE_BODY_BYTES = 25_000_000;

/** Body fetches in flight at once, as browse's `MAX_FINALIZERS`. */
export const MAX_BODY_FETCHES = 4;

const PARSED_BODY = /json|application\/x-www-form-urlencoded|multipart\/form-data/i;

const NO_BODY_STATUS = new Set([204, 205, 304]);

const MAX_EARLY = 500;

const NEVER = new AbortController().signal;

interface Response {
  status: number;
  statusText: string;
  headers: Header[];
  mimeType: string;
}

interface Hop {
  id: string;
  requestId: string;
  startedAt: number;
  timestamp: number;
  method: string;
  url: string;
  headers: Header[];
  resourceType: string;
  postData?: string;
  hasPostData: boolean;
  redirectedFrom?: string;
  response?: Response;
}

interface Extra {
  request?: Header[];
  response?: Header[];
}

/** Requests and responses from one tab's main frame, redacted before they are stored. */
export interface NetworkCapture {
  take(match?: (entry: NetworkEntry) => boolean): Taken<NetworkEntry>;
  /** Requests started but not yet stored: in flight, or waiting for their bodies. */
  pending(): number;
  /** Stops listening and stores what is in flight as it is. */
  stop(): void;
}

export interface NetworkCaptureOptions {
  cdp: Cdp;
  tabId: number;
  frameId: string;
  redactor: SecretRedactor;
  bodies: boolean;
  limit?: number;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function headersOf(value: unknown): Header[] {
  return Object.entries(record(value)).flatMap(([name, raw]) =>
    String(raw)
      .split('\n')
      .map((line) => ({ name, value: line })),
  );
}

function headerValue(headers: Header[], name: string) {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? '';
}

function merge(base: Header[], extra: Header[] | undefined) {
  if (!extra) return base;

  const names = new Set(extra.map((header) => header.name.toLowerCase()));

  return [...base.filter((header) => !names.has(header.name.toLowerCase())), ...extra];
}

function responseOf(value: unknown): Response {
  const response = record(value);

  return {
    status: number(response.status),
    statusText: text(response.statusText),
    headers: headersOf(response.headers),
    mimeType: text(response.mimeType),
  };
}

function decodeBase64(data: string) {
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async <T>(task: () => Promise<T>) => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));

    active++;

    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function captureNetwork({
  cdp,
  tabId,
  frameId,
  redactor,
  bodies,
  limit,
}: NetworkCaptureOptions): NetworkCapture {
  const buffer: CaptureBuffer<NetworkEntry> = createBuffer(limit);
  const hops = new Map<string, Hop>();
  const redirects = new Map<string, number>();
  const early = new Map<string, Extra>();
  const finishing = new Map<string, NetworkEntry>();
  const fetches = limiter(MAX_BODY_FETCHES);
  let bodyBytes = 0;
  let stopped = false;

  const store = (entry: NetworkEntry) => {
    buffer.push(redactKnown(protectEntry(entry, redactor), redactor));
  };

  const extraFor = (requestId: string) => {
    const extra = early.get(requestId) ?? {};

    early.delete(requestId);
    early.set(requestId, extra);

    if (early.size > MAX_EARLY) early.delete(early.keys().next().value ?? '');

    return extra;
  };

  const entryOf = (hop: Hop, extra: Extra, end?: number): NetworkEntry => {
    const response = hop.response;

    return {
      id: hop.id,
      startedAt: hop.startedAt,
      ...(end === undefined
        ? {}
        : { durationMs: Math.max(0, Math.round((end - hop.timestamp) * 1000)) }),
      request: {
        method: hop.method,
        url: hop.url,
        headers: merge(hop.headers, extra.request),
        resourceType: hop.resourceType,
        ...(hop.redirectedFrom ? { redirectedFrom: hop.redirectedFrom } : {}),
      },
      ...(response
        ? {
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: merge(response.headers, extra.response),
            },
          }
        : {}),
    };
  };

  const claim = (size: number): BodyOmitted | undefined => {
    if (size > MAX_BODY_BYTES || bodyBytes + size > MAX_CAPTURE_BODY_BYTES) return 'size';

    bodyBytes += size;

    return undefined;
  };

  const keep = (raw: string, mimeType: string): CapturedBody => {
    const omitted = claim(raw.length);

    return omitted
      ? { size: raw.length, mimeType, omitted }
      : { size: raw.length, mimeType, text: raw };
  };

  const fetch = async (method: string, requestId: string) =>
    record(
      await fetches(() =>
        race(cdp.send(tabId, method, { requestId }), NEVER, {
          ms: COMMAND_TIMEOUT_MS,
          what: method,
        }),
      ),
    );

  const inlineBody = (hop: Hop): CapturedBody | undefined | null => {
    const mimeType = headerValue(hop.headers, 'content-type');

    if (hop.postData === undefined && !hop.hasPostData) return undefined;
    if (!PARSED_BODY.test(mimeType)) {
      return { size: hop.postData?.length ?? 0, mimeType, omitted: 'type' };
    }

    return hop.postData === undefined ? null : keep(hop.postData, mimeType);
  };

  const requestBody = async (hop: Hop): Promise<CapturedBody | undefined> => {
    const inline = inlineBody(hop);

    if (inline !== null) return inline;

    const mimeType = headerValue(hop.headers, 'content-type');

    try {
      return keep(
        text((await fetch('Network.getRequestPostData', hop.requestId)).postData),
        mimeType,
      );
    } catch {
      return { size: 0, mimeType, omitted: 'unavailable' };
    }
  };

  const responseBody = async (hop: Hop, size: number): Promise<CapturedBody | undefined> => {
    const response = hop.response;

    if (!response || hop.method === 'HEAD' || NO_BODY_STATUS.has(response.status)) return undefined;

    const { mimeType } = response;

    if (!PARSED_BODY.test(mimeType)) return { size, mimeType, omitted: 'type' };
    if (size > MAX_BODY_BYTES) return { size, mimeType, omitted: 'size' };

    try {
      const reply = await fetch('Network.getResponseBody', hop.requestId);
      const body = text(reply.body);

      return keep(reply.base64Encoded === true ? decodeBase64(body) : body, mimeType);
    } catch {
      return { size, mimeType, omitted: 'unavailable' };
    }
  };

  const finish = (hop: Hop, end: number, outcome: { size?: number; failure?: string }) => {
    hops.delete(hop.requestId);

    const entry = entryOf(hop, extraFor(hop.requestId), end);

    early.delete(hop.requestId);
    redirects.delete(hop.requestId);

    if (outcome.failure !== undefined) entry.failure = outcome.failure;

    if (!bodies) return store(entry);

    finishing.set(hop.id, entry);

    void Promise.all([
      requestBody(hop),
      outcome.failure === undefined ? responseBody(hop, outcome.size ?? 0) : undefined,
    ]).then(([request, response]) => {
      if (stopped || !finishing.delete(hop.id)) return;

      if (request) entry.request.body = request;
      if (response && entry.response) entry.response.body = response;

      store(entry);
    });
  };

  const redirect = (hop: Hop, params: Record<string, unknown>) => {
    hop.response = responseOf(params.redirectResponse);

    const extra = extraFor(hop.requestId);
    const entry = entryOf(hop, extra, number(params.timestamp, hop.timestamp));

    early.set(hop.requestId, {});

    if (bodies) {
      const body = inlineBody(hop);

      if (body !== undefined) {
        entry.request.body = body ?? {
          size: 0,
          mimeType: headerValue(hop.headers, 'content-type'),
          omitted: 'unavailable',
        };
      }
    }

    store(entry);
  };

  const learnHeaders = (headers: Header[]) => {
    redactor.protectHeaders(headers);

    return headers;
  };

  const learn = (hop: Hop) => {
    redactor.protectUrl(hop.url);
    learnHeaders(hop.headers);

    if (hop.postData !== undefined) {
      redactor.protectBody(hop.postData, headerValue(hop.headers, 'content-type'));
    }
  };

  const begin = (params: Record<string, unknown>) => {
    const requestId = text(params.requestId);
    const request = record(params.request);
    const url = text(request.url);

    if (!requestId || text(params.frameId) !== frameId || url.startsWith('data:')) return;

    const previous = hops.get(requestId);

    if (previous && params.redirectResponse) redirect(previous, params);

    const count = redirects.get(requestId) ?? 0;

    redirects.set(requestId, count + 1);

    const hop: Hop = {
      id: count === 0 ? requestId : `${requestId}.${count}`,
      requestId,
      startedAt: Math.round(number(params.wallTime, Date.now() / 1000) * 1000),
      timestamp: number(params.timestamp),
      method: text(request.method, 'GET'),
      url,
      headers: headersOf(request.headers),
      resourceType: text(params.type, 'Other'),
      ...(typeof request.postData === 'string' ? { postData: request.postData } : {}),
      hasPostData: request.hasPostData === true,
      ...(previous && params.redirectResponse ? { redirectedFrom: previous.url } : {}),
    };

    learn(hop);
    hops.set(requestId, hop);
  };

  const onEvent = (event: CdpEvent) => {
    if (event.tabId !== tabId || stopped) return;

    const { params } = event;
    const requestId = text(params.requestId);

    switch (event.method) {
      case 'Network.requestWillBeSent':
        return begin(params);
      case 'Network.requestWillBeSentExtraInfo':
        extraFor(requestId).request = learnHeaders(headersOf(params.headers));

        return;
      case 'Network.responseReceivedExtraInfo':
        extraFor(requestId).response = learnHeaders(headersOf(params.headers));

        return;
    }

    const hop = hops.get(requestId);

    if (!hop) return;

    if (event.method === 'Network.responseReceived') {
      hop.response = responseOf(params.response);
      learnHeaders(hop.response.headers);
      hop.resourceType = text(params.type, hop.resourceType);
    } else if (event.method === 'Network.loadingFinished') {
      finish(hop, number(params.timestamp, hop.timestamp), {
        size: number(params.encodedDataLength),
      });
    } else if (event.method === 'Network.loadingFailed') {
      const blocked = text(params.blockedReason);
      const failure = text(params.errorText, 'failed');

      finish(hop, number(params.timestamp, hop.timestamp), {
        failure: blocked ? `${failure} (${blocked})` : failure,
      });
    }
  };

  const unsubscribe = cdp.onEvent(onEvent);

  return {
    take: (match) => buffer.take(match),
    pending: () => hops.size + finishing.size,
    stop: () => {
      if (stopped) return;

      stopped = true;
      unsubscribe();

      for (const entry of finishing.values()) store(entry);

      for (const hop of hops.values()) store(entryOf(hop, early.get(hop.requestId) ?? {}));

      finishing.clear();
      hops.clear();
      early.clear();
    },
  };
}
