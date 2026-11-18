import { type Header, isRecord, MIN_KNOWN_LENGTH, type SecretRedactor } from './redact';

const MIN_KNOWN_BODY_LENGTH = 16;

/** A request or response body. `text` is absent when it was kept out, and `omitted` says why. */
export interface CapturedBody {
  size: number;
  mimeType: string;
  text?: string;
  omitted?: 'size' | 'type' | 'unparsed';
}

/** One request and its response or failure. */
export interface NetworkEntry {
  id: string;
  startedAt: number;
  durationMs?: number;
  request: {
    method: string;
    url: string;
    headers: Header[];
    resourceType: string;
    body?: CapturedBody;
    redirectedFrom?: string;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Header[];
    body?: CapturedBody;
  };
  failure?: string;
}

function protectBody(body: CapturedBody | undefined, redactor: SecretRedactor) {
  if (!body?.text) return body;

  const text = redactor.protectBody(body.text, body.mimeType);

  return text === undefined
    ? { size: body.size, mimeType: body.mimeType, omitted: 'unparsed' as const }
    : { ...body, text };
}

/** Hides credentials by name: secret headers, cookies, URL fields, token-like paths and body fields. */
export function protectEntry(entry: NetworkEntry, redactor: SecretRedactor): NetworkEntry {
  const { request, response } = entry;
  const requestBody = protectBody(request.body, redactor);
  const responseBody = protectBody(response?.body, redactor);

  return {
    ...entry,
    request: {
      ...request,
      url: redactor.protectUrl(request.url),
      headers: redactor.protectHeaders(request.headers),
      ...(requestBody ? { body: requestBody } : {}),
      ...(request.redirectedFrom
        ? { redirectedFrom: redactor.protectUrl(request.redirectedFrom) }
        : {}),
    },
    ...(response
      ? {
          response: {
            ...response,
            headers: redactor.protectHeaders(response.headers),
            ...(responseBody ? { body: responseBody } : {}),
          },
        }
      : {}),
  };
}

function redactJson(value: unknown, redactor: SecretRedactor): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redactor));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item, redactor)]),
    );
  }

  if (typeof value === 'string') {
    return redactor.redactKnownBodySubstrings(value, MIN_KNOWN_BODY_LENGTH);
  }

  return redactor.redactScalar(value);
}

function redactBody(body: CapturedBody | undefined, redactor: SecretRedactor) {
  if (!body?.text) return body;
  if (!body.mimeType.toLowerCase().includes('json')) {
    return { ...body, text: redactor.redactKnownBodySubstrings(body.text, MIN_KNOWN_BODY_LENGTH) };
  }

  try {
    return { ...body, text: JSON.stringify(redactJson(JSON.parse(body.text), redactor)) };
  } catch {
    return { size: body.size, mimeType: body.mimeType, omitted: 'unparsed' as const };
  }
}

/**
 * Hides values the redactor already knows wherever else they show up in a protected entry. Run it
 * again at read time, so values learned from later entries also cover earlier ones.
 */
export function redactKnown(entry: NetworkEntry, redactor: SecretRedactor): NetworkEntry {
  const text = (value: string) => redactor.redactKnownSubstrings(value, MIN_KNOWN_LENGTH);
  const headers = (list: Header[]) => list.map((item) => ({ ...item, value: text(item.value) }));
  const { request, response, failure } = entry;
  const requestBody = redactBody(request.body, redactor);
  const responseBody = redactBody(response?.body, redactor);

  return {
    ...entry,
    request: {
      ...request,
      url: text(request.url),
      headers: headers(request.headers),
      ...(requestBody ? { body: requestBody } : {}),
      ...(request.redirectedFrom ? { redirectedFrom: text(request.redirectedFrom) } : {}),
    },
    ...(response
      ? {
          response: {
            ...response,
            headers: headers(response.headers),
            ...(responseBody ? { body: responseBody } : {}),
          },
        }
      : {}),
    ...(failure ? { failure: text(failure) } : {}),
  };
}
