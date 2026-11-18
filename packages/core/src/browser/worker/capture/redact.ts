import {
  protectFragment,
  protectPathSegments,
  protectSearchParams,
  SECRET_NAME,
} from './redact-url';

export { looksLikeToken, SECRET_NAME } from './redact-url';

/** What a hidden credential is replaced with. */
export const REDACTED = '[redacted]';

const SENTINEL = '__sidekick_redacted__';

/**
 * Known values shorter than this are not replaced inside unrelated text, since short strings
 * collide with ordinary text. A whole text that equals a known value is still replaced.
 */
export const MIN_KNOWN_LENGTH = 8;

const ONE_TIME_FIELD =
  /pass(?:word|wd|code|phrase)|(?:^|[-_.])pwd(?:$|[-_.])|otp|totp|(?:^|[-_.])(?:mfa_?|2fa_?|verification_?|auth_?)?code(?:$|[-_.])|(?:^|[-_.])pin(?:$|[-_.])/i;

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-csrf-token',
  'csrf-token',
  'x-xsrf-token',
]);

const NON_SECRET_HEADERS = new Set([
  ':authority',
  ':method',
  ':scheme',
  ':status',
  ':protocol',
  'access-control-allow-credentials',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-request-method',
  'access-control-request-headers',
  'access-control-allow-private-network',
  'access-control-request-private-network',
]);

const COOKIE_ATTRIBUTE =
  /^(?:domain|path|expires|max-age|samesite|priority|partitioned|secure|httponly)$/i;

const URL_HEADERS = new Set(['location', 'referer', 'referrer']);

/** A request or response header. */
export interface Header {
  name: string;
  value: string;
}

type JsonField = 'open' | 'secret' | 'codeListing' | 'codeVoice';

/** Whether `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restore(value: string) {
  return value.replaceAll(SENTINEL, REDACTED);
}

function jsonField(key: string, inherited: JsonField, type: unknown, value: unknown): JsonField {
  if (inherited === 'secret') return 'secret';
  if (!SECRET_NAME.test(key)) return inherited;
  if (key !== 'code') return 'secret';
  if (type === 'codeListing' && Array.isArray(value)) return 'codeListing';
  if (type === 'codeVoice' && typeof value === 'string') return 'codeVoice';

  return 'secret';
}

/**
 * Hides credential-shaped values in captured requests, responses and console text, ported from
 * browse's network-capture redaction. Every hidden value is remembered, so it is also hidden where
 * it shows up later under a name that does not look secret. Use one per capture, so remembered
 * values never cross tabs.
 */
export class SecretRedactor {
  private readonly known = new Set<string>();
  private readonly namedFields = new Set<string>();
  private readonly always = new Set<string>();

  protectHeaders(headers: readonly Header[]): Header[] {
    return headers.map(({ name, value }) => ({
      name,
      value: restore(this.protectHeader(name, value)),
    }));
  }

  protectUrl(raw: string): string {
    const hash = raw.indexOf('#');
    const base = hash < 0 ? raw : raw.slice(0, hash);
    const query = (name: string, value: string) => this.scrubUrlField(value, name);
    const path = (pathname: string) =>
      protectPathSegments(pathname, (segment) => this.scrub(segment));

    let result: string;

    try {
      const url = new URL(base);

      url.pathname = path(url.pathname);
      url.search = protectSearchParams(url.searchParams, query).toString();
      result = url.toString();
    } catch {
      const start = base.indexOf('?');

      result =
        start < 0
          ? path(base)
          : `${path(base.slice(0, start))}?${protectSearchParams(new URLSearchParams(base.slice(start + 1)), query).toString()}`;
    }

    result = restore(result);

    if (hash < 0) return result;

    return `${result}#${restore(protectFragment(raw.slice(hash + 1), query))}`;
  }

  /** The body with secret fields hidden, or `undefined` when it can't be parsed safely. */
  protectBody(body: string, contentType: string | undefined): string | undefined {
    const type = contentType?.toLowerCase() ?? '';

    if (type.includes('json')) {
      try {
        return restore(JSON.stringify(this.protectJson(JSON.parse(body), 'open')));
      } catch {
        return undefined;
      }
    }

    if (type.includes('application/x-www-form-urlencoded')) {
      const params = protectSearchParams(new URLSearchParams(body), (name, value) =>
        this.scrub(value, name),
      );

      return restore(params.toString());
    }

    if (type.includes('multipart/form-data')) {
      const protectedBody = this.protectMultipart(body, contentType ?? '');

      return protectedBody === undefined ? undefined : restore(protectedBody);
    }

    return undefined;
  }

  /** Hides remembered values in free text, such as a console message. */
  redactText(text: string): string {
    if (this.known.has(text)) return REDACTED;

    return this.redactKnownSubstrings(text, MIN_KNOWN_LENGTH);
  }

  redactKnownSubstrings(text: string, minimum: number): string {
    return this.redactKnown(text, (value) => value.length >= minimum || this.always.has(value));
  }

  /**
   * The pass over strings inside a body. Values from a secret-named URL query or fragment field
   * are credentials by name, so they are replaced from `MIN_KNOWN_LENGTH` even where body strings
   * use a higher floor.
   */
  redactKnownBodySubstrings(text: string, minimum: number): string {
    return this.redactKnown(
      text,
      (value) =>
        value.length >= minimum ||
        (value.length >= MIN_KNOWN_LENGTH && this.namedFields.has(value)) ||
        this.always.has(value),
    );
  }

  /** Hides a number or boolean that equals a remembered value. */
  redactScalar(value: unknown): unknown {
    if (typeof value !== 'number' && typeof value !== 'boolean') return value;

    const text = String(value);

    return this.known.has(text) || this.always.has(text) ? REDACTED : value;
  }

  private redactKnown(text: string, include: (value: string) => boolean) {
    const entries: string[] = [];

    for (const value of this.known) {
      if (!include(value)) continue;

      entries.push(value);

      const encoded = encodeURIComponent(value);

      if (encoded !== value) entries.push(encoded);
    }

    return entries
      .sort((left, right) => right.length - left.length)
      .reduce((output, entry) => output.split(entry).join(REDACTED), text);
  }

  private scrub(value: string, field = '') {
    if (!value) return value;

    this.known.add(value);

    if (ONE_TIME_FIELD.test(field)) this.always.add(value);

    return SENTINEL;
  }

  private scrubUrlField(value: string, field: string) {
    if (value) this.namedFields.add(value);

    return this.scrub(value, field);
  }

  private protectCookies(value: string, set: boolean) {
    const line = (text: string) =>
      text
        .split(/;\s*/)
        .map((part, index) => {
          const separator = part.indexOf('=');

          if (separator < 1) return part;

          const name = part.slice(0, separator).trim();
          const cookie = part.slice(separator + 1);

          if (set && index > 0 && COOKIE_ATTRIBUTE.test(name)) return part;
          if (!cookie) return part;

          return `${name}=${this.scrub(cookie)}`;
        })
        .join('; ');

    return set ? value.split('\n').map(line).join('\n') : line(value);
  }

  private protectHeader(name: string, value: string) {
    if (!value) return value;

    const lower = name.toLowerCase();

    if (lower === ':path') return this.protectUrl(value);
    if (NON_SECRET_HEADERS.has(lower)) return value;
    if (lower === 'cookie' || lower === 'set-cookie') {
      return this.protectCookies(value, lower === 'set-cookie');
    }

    if (URL_HEADERS.has(lower)) return this.protectUrl(value);
    if (lower === 'authorization' || lower === 'proxy-authorization') {
      const match = /^(\S+)\s+(.+)$/.exec(value);

      if (match) return `${match[1]} ${this.scrub(match[2] ?? '')}`;
    }

    if (SECRET_HEADERS.has(lower) || SECRET_NAME.test(lower)) return this.scrub(value);

    return value;
  }

  private protectJson(value: unknown, field: JsonField, fieldName = ''): unknown {
    if (Array.isArray(value)) {
      if (field === 'codeListing') {
        return value.map((item) =>
          typeof item === 'string' ? item : this.protectJson(item, 'secret', fieldName),
        );
      }

      return value.map((item) => this.protectJson(item, field, fieldName));
    }

    if (isRecord(value)) {
      const inherited = field === 'codeListing' || field === 'codeVoice' ? 'secret' : field;

      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.protectJson(item, jsonField(key, inherited, value.type, item), key),
        ]),
      );
    }

    if (field === 'open' || value === null || value === '') return value;
    if (field === 'codeVoice' && typeof value === 'string') return value;

    return this.scrub(String(value), fieldName);
  }

  private protectMultipart(body: string, contentType: string) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);

    if (!boundary) return undefined;

    const delimiter = `--${boundary}`;
    const parts = body.split(delimiter);

    if (parts.length < 3) return undefined;

    for (let index = 1; index < parts.length - 1; index += 1) {
      const part = parts[index] ?? '';

      if (!part.startsWith('\r\n') || !part.endsWith('\r\n')) return undefined;

      const headerEnd = part.indexOf('\r\n\r\n');

      if (headerEnd < 0) return undefined;

      const disposition = part
        .slice(2, headerEnd)
        .split('\r\n')
        .find((line) => /^content-disposition:/i.test(line));

      if (!disposition || /;\s*filename\*?=/i.test(disposition)) return undefined;

      const name = /;\s*name="([^"]+)"/i.exec(disposition)?.[1];

      if (!name) return undefined;

      const start = headerEnd + 4;
      const end = part.length - 2;

      if (start > end) return undefined;

      const value = part.slice(start, end);

      if (!value || !SECRET_NAME.test(name)) continue;

      parts[index] = `${part.slice(0, start)}${this.scrub(value, name)}${part.slice(end)}`;
    }

    return parts.join(delimiter);
  }
}
