import { describe, expect, it } from 'vitest';

import { type NetworkEntry, protectEntry, redactKnown } from './entry';
import { SecretRedactor } from './redact';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

function entry(url: string, headers: NetworkEntry['request']['headers'] = []): NetworkEntry {
  return { id: '1', startedAt: 0, request: { method: 'GET', url, headers, resourceType: 'XHR' } };
}

describe('independent review of PR #33', () => {
  it('replaces a URL fragment that is a bare token or an encoded or bracketed secret pair (spec 6.3)', () => {
    const redactor = new SecretRedactor();
    const fragments = [
      `https://app.test/auth/callback#${JWT}`,
      'https://a.test/cb#access_token%3Dfrag_enc_ABCDEF123456',
      'https://a.test/cb#x[token]=frag_brk_ABCDEF123456',
    ].map((url) => redactor.protectUrl(url));

    expect(fragments[0]).not.toContain(JWT);
    expect(fragments[1]).not.toContain('frag_enc_ABCDEF123456');
    expect(fragments[2]).not.toContain('frag_brk_ABCDEF123456');
  });

  it('replaces the value of a nameless Cookie and Set-Cookie (spec 6.2)', () => {
    const [cookie, setCookie, bare] = new SecretRedactor().protectHeaders([
      { name: 'Cookie', value: 'theme=dark; s3ss1onRawValue42' },
      { name: 'Set-Cookie', value: '=s3ss1onRawValue43; Path=/; HttpOnly' },
      { name: 'Set-Cookie', value: 's3ss1onRawValue44; Path=/' },
    ]);

    expect(cookie?.value).not.toContain('s3ss1onRawValue42');
    expect(setCookie?.value).not.toContain('s3ss1onRawValue43');
    expect(setCookie?.value).toContain('Path=/; HttpOnly');
    expect(bare?.value).not.toContain('s3ss1onRawValue44');
  });

  it('replaces every cookie in a comma-joined Set-Cookie line (spec 6.2)', () => {
    const [setCookie] = new SecretRedactor().protectHeaders([
      { name: 'Set-Cookie', value: 'a=1; Path=/, sid=topsecret999; Path=/; HttpOnly' },
    ]);

    expect(setCookie?.value).not.toContain('topsecret999');
  });

  it('replaces a secret field in an unterminated last multipart part (spec 6.4)', () => {
    const multipart =
      '--b\r\nContent-Disposition: form-data; name="user"\r\n\r\ndax\r\n' +
      '--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2hunter2\r\n';

    const result = new SecretRedactor().protectBody(multipart, 'multipart/form-data; boundary=b');

    expect(result ?? '').not.toContain('hunter2hunter2');
  });

  it('replaces secret query values in URL-valued response headers (spec 6.3)', () => {
    const text = JSON.stringify(
      new SecretRedactor().protectHeaders([
        { name: 'Content-Location', value: 'https://api.test/me?access_token=tok_CL_ABCDEF123456' },
        { name: 'Refresh', value: '0; url=https://api.test/next?token=tok_RF_ABCDEF123456' },
        { name: 'Link', value: '<https://api.test/p2?session=tok_LK_ABCDEF123456>; rel="next"' },
      ]),
    );

    expect(text).not.toContain('tok_CL_ABCDEF123456');
    expect(text).not.toContain('tok_RF_ABCDEF123456');
    expect(text).not.toContain('tok_LK_ABCDEF123456');
  });

  it('keeps ordinary numbers and names readable after a body with {"code":0} or {"author":...} (spec Brief)', () => {
    const redactor = new SecretRedactor();

    redactor.protectBody(
      '{"code":0,"tokenCount":1,"author":"Jane Doe","footprint":"x"}',
      'application/json',
    );

    expect(redactor.redactText('Loaded 2048 rows in 0.50s')).toBe('Loaded 2048 rows in 0.50s');
    expect(redactor.redactText('by Jane Doe')).toBe('by Jane Doe');
    expect(redactor.redactScalar(1)).toBe(1);

    const stored = redactKnown(
      protectEntry(entry('https://a.test/list?page=10&limit=100'), redactor),
      redactor,
    );

    expect(stored.request.url).toBe('https://a.test/list?page=10&limit=100');
  });
});

describe('around the PR #33 fixes', () => {
  it('keeps Set-Cookie dates, plain anchors and hash routes, and whole-word auth names', () => {
    const redactor = new SecretRedactor();
    const [setCookie, author, auth] = redactor.protectHeaders([
      { name: 'Set-Cookie', value: 'sid=abc12345; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure' },
      { name: 'X-Author', value: 'Jane Doe' },
      { name: 'X-Auth', value: 'Jane Doe' },
    ]);

    expect(setCookie?.value).toBe('sid=[redacted]; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure');
    expect(author?.value).toBe('Jane Doe');
    expect(auth?.value).toBe('[redacted]');

    expect(redactor.protectUrl('https://a.test/docs#section-2')).toBe(
      'https://a.test/docs#section-2',
    );

    expect(redactor.protectUrl('https://a.test/#/settings/profile')).toBe(
      'https://a.test/#/settings/profile',
    );

    expect(redactor.redactText('state 2048 rows')).toBe('state 2048 rows');
  });

  it('remembers every value in a replaced fragment, so it stays hidden in later text', () => {
    const redactor = new SecretRedactor();

    redactor.protectUrl('https://a.test/cb#state=xyz&access_token=frag_tok_ABCDEF123456');

    expect(redactor.redactText('got frag_tok_ABCDEF123456')).toBe('got [redacted]');
  });
});
