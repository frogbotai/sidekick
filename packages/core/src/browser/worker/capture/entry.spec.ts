import { describe, expect, it } from 'vitest';

import { type CapturedBody, type NetworkEntry, protectEntry, redactKnown } from './entry';
import { REDACTED, SecretRedactor } from './redact';

function body(text: string, mimeType = 'application/json'): CapturedBody {
  return { size: text.length, mimeType, text };
}

function entry(id: string, response: unknown, request?: unknown): NetworkEntry {
  return {
    id,
    startedAt: 0,
    request: {
      method: request === undefined ? 'GET' : 'POST',
      url: `https://docs.example.com/${id}`,
      headers: [{ name: 'accept', value: 'application/json' }],
      resourceType: 'XHR',
      ...(request === undefined ? {} : { body: body(JSON.stringify(request)) }),
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'content-type', value: 'application/json' }],
      body: body(JSON.stringify(response)),
    },
  };
}

function store(entries: NetworkEntry[]) {
  const redactor = new SecretRedactor();

  return entries
    .map((item) => protectEntry(item, redactor))
    .map((item) => redactKnown(item, redactor));
}

function responseJson(item: NetworkEntry | undefined) {
  return JSON.parse(item?.response?.body?.text ?? '{}');
}

describe('a stored network entry (sidekick-18 req. 6, 7)', () => {
  it('holds no raw secret from any category', () => {
    const secrets = {
      bearer: 'bearer-6e1f0c8a9b7d4e2f',
      apiKey: 'apikey-3c9d8e7f6a5b4c3d',
      cookie: 'cookie-9a8b7c6d5e4f3a2b',
      setCookie: 'setcookie-1a2b3c4d5e6f',
      query: 'querytoken-7f6e5d4c3b2a',
      fragment: 'fragment-0a9b8c7d6e5f',
      path: 'Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1x',
      jsonField: 'jsonsecret-2b3c4d5e6f7a',
      formField: 'formpassword-8e9f0a1b',
      multipartField: 'multipart-otp-4c5d6e7f',
    };

    const multipart = `--zz\r\nContent-Disposition: form-data; name="otp"\r\n\r\n${secrets.multipartField}\r\n--zz--\r\n`;
    const [json, form, parts] = store([
      {
        id: 'json',
        startedAt: 0,
        request: {
          method: 'POST',
          url: `https://app.test/api/${secrets.path}/save?access_token=${secrets.query}#id_token=${secrets.fragment}`,
          headers: [
            { name: 'Authorization', value: `Bearer ${secrets.bearer}` },
            { name: 'X-Api-Key', value: secrets.apiKey },
            { name: 'Cookie', value: `sid=${secrets.cookie}` },
          ],
          resourceType: 'Fetch',
          body: body(JSON.stringify({ title: '', client_secret: secrets.jsonField })),
        },
        response: {
          status: 422,
          statusText: 'Unprocessable',
          headers: [{ name: 'Set-Cookie', value: `sid=${secrets.setCookie}; Path=/; HttpOnly` }],
          body: body(JSON.stringify({ error: 'Title is required', echo: secrets.bearer })),
        },
      },
      {
        id: 'form',
        startedAt: 0,
        request: {
          method: 'POST',
          url: 'https://app.test/login',
          headers: [],
          resourceType: 'Document',
          body: body(`user=ada&password=${secrets.formField}`, 'application/x-www-form-urlencoded'),
        },
      },
      {
        id: 'multipart',
        startedAt: 0,
        request: {
          method: 'POST',
          url: 'https://app.test/verify',
          headers: [],
          resourceType: 'Fetch',
          body: body(multipart, 'multipart/form-data; boundary=zz'),
        },
        failure: `net::ERR_FAILED for token ${secrets.query}`,
      },
    ]);

    const stored = JSON.stringify([json, form, parts]);

    for (const secret of Object.values(secrets)) expect(stored).not.toContain(secret);

    expect(json?.request.url).toBe(
      `https://app.test/api/${REDACTED}/save?access_token=${REDACTED}#id_token=${REDACTED}`,
    );

    expect(responseJson(json)).toEqual({ error: 'Title is required', echo: REDACTED });
    expect(json?.response?.headers[0]?.value).toBe(`sid=${REDACTED}; Path=/; HttpOnly`);
    expect(form?.request.body?.text).toBe(`user=ada&password=${REDACTED}`);
    expect(parts?.request.body?.text).toContain(`name="otp"\r\n\r\n${REDACTED}\r\n`);
    expect(parts?.failure).toBe(`net::ERR_FAILED for token ${REDACTED}`);
  });

  it('keeps out a body it cannot parse, and says so', () => {
    const [stored] = store([
      {
        ...entry('html', {}),
        response: {
          status: 500,
          statusText: 'Error',
          headers: [],
          body: body('<p>token=abc</p>', 'text/html'),
        },
      },
    ]);

    expect(stored?.response?.body).toEqual({
      size: 16,
      mimeType: 'text/html',
      omitted: 'unparsed',
    });
  });

  it('protects :path query values under the request URL', () => {
    const short = entry('short', {});
    const [stored] = store([
      {
        ...short,
        request: {
          ...short.request,
          url: 'https://docs.example.com/callback?code=492817&x=1',
          headers: [
            { name: ':path', value: '/callback?code=492817&x=1' },
            { name: ':authority', value: 'docs.example.com' },
          ],
        },
      },
    ]);

    expect(stored?.request.url).toBe(`https://docs.example.com/callback?code=${REDACTED}&x=1`);

    expect(stored?.request.headers).toEqual([
      { name: ':path', value: `/callback?code=${REDACTED}&x=1` },
      { name: ':authority', value: 'docs.example.com' },
    ]);
  });

  it('finds a short secret-named URL value in an ordinary body string', () => {
    const base = entry('echo', {
      url: 'https://x.example.com/y?api_key=k1234567890',
      note: 'signed f1234567890',
    });

    const [stored] = store([
      {
        ...base,
        request: {
          ...base.request,
          url: 'https://docs.example.com/echo?api_key=k1234567890#signature=f1234567890',
        },
      },
    ]);

    expect(stored?.request.url).toBe(
      `https://docs.example.com/echo?api_key=${REDACTED}#signature=${REDACTED}`,
    );

    expect(responseJson(stored)).toEqual({
      url: `https://x.example.com/y?api_key=${REDACTED}`,
      note: `signed ${REDACTED}`,
    });
  });

  it('leaves short values from other sources alone in body strings', () => {
    const base = entry('note', { note: 'sid=abcdef1234' });
    const [stored] = store([
      {
        ...base,
        request: { ...base.request, headers: [{ name: 'cookie', value: 'sid=abcdef1234' }] },
      },
    ]);

    expect(stored?.request.headers).toEqual([{ name: 'cookie', value: `sid=${REDACTED}` }]);
    expect(responseJson(stored)).toEqual({ note: 'sid=abcdef1234' });
  });

  it('leaves short secret-named form values alone in body strings', () => {
    const base = entry('form', { url: 'https://x.example.com/y?api_key=k1234567890' });
    const [stored] = store([
      {
        ...base,
        request: {
          ...base.request,
          body: body('api_key=k1234567890', 'application/x-www-form-urlencoded'),
        },
      },
    ]);

    expect(stored?.request.body?.text).toBe(`api_key=${REDACTED}`);
    expect(responseJson(stored)).toEqual({ url: 'https://x.example.com/y?api_key=k1234567890' });
  });

  it('keeps code listings while hiding codes in requests and responses', () => {
    const listing = { type: 'codeListing', code: ['struct MyView: View {', '}'] };
    const echo = { code: 'a7k2m9' };
    const [listingEntry, otpEntry, echoEntry] = store([
      entry('listing', listing),
      entry('otp', { code: '492817' }),
      entry('echo', echo, echo),
    ]);

    expect(responseJson(listingEntry)).toEqual(listing);
    expect(responseJson(otpEntry)).toEqual({ code: REDACTED });
    expect(echoEntry?.request.body?.text).toBe(echoEntry?.response?.body?.text);
    expect(responseJson(echoEntry)).toEqual({ code: REDACTED });
  });

  it('covers an earlier entry with a value learned later when the known pass runs again', () => {
    const redactor = new SecretRedactor();
    const early = protectEntry(entry('early', { note: 'token-learned-later-12345' }), redactor);
    const late = entry('late', {});

    protectEntry(
      {
        ...late,
        request: {
          ...late.request,
          headers: [{ name: 'X-Token', value: 'token-learned-later-12345' }],
        },
      },
      redactor,
    );

    expect(responseJson(redactKnown(early, redactor))).toEqual({ note: REDACTED });
  });
});
