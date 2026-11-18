import { describe, expect, it } from 'vitest';

import { looksLikeToken, MIN_KNOWN_LENGTH, REDACTED, SecretRedactor } from './redact';

function json(body: unknown) {
  return JSON.parse(
    new SecretRedactor().protectBody(JSON.stringify(body), 'application/json') ?? '{}',
  );
}

describe('headers (sidekick-18 req. 6.1, 6.2)', () => {
  it('keeps the scheme of an Authorization header and hides its credential', () => {
    const [authorization, accept] = new SecretRedactor().protectHeaders([
      { name: 'Authorization', value: 'Bearer sk_test_SECRETVALUE1234567890' },
      { name: 'Accept', value: 'application/json' },
    ]);

    expect(authorization).toEqual({ name: 'Authorization', value: `Bearer ${REDACTED}` });
    expect(accept).toEqual({ name: 'Accept', value: 'application/json' });
  });

  it('hides each cookie value but keeps cookie names and attributes', () => {
    const [cookie] = new SecretRedactor().protectHeaders([
      { name: 'Set-Cookie', value: 'sid=abcdef123456; Path=/; HttpOnly' },
    ]);

    expect(cookie?.value).toBe(`sid=${REDACTED}; Path=/; HttpOnly`);
  });

  it('never hides hosts, CORS header values or cookie attributes', () => {
    const redactor = new SecretRedactor();
    const [authority, authorization, xAuthToken] = redactor.protectHeaders([
      { name: ':authority', value: 'jsonplaceholder.typicode.com' },
      { name: 'authorization', value: 'Bearer ctl-bearer-value-0001' },
      { name: 'x-auth-token', value: 'ctl-xauth-value-0002' },
    ]);

    expect(authority?.value).toBe('jsonplaceholder.typicode.com');
    expect(authorization?.value).toBe(`Bearer ${REDACTED}`);
    expect(xAuthToken?.value).toBe(REDACTED);

    const [cors, setCookie] = redactor.protectHeaders([
      { name: 'access-control-allow-credentials', value: 'true' },
      {
        name: 'set-cookie',
        value: 'probe=secretvalue123; Max-Age=0; Priority=High; Partitioned; Secure; HttpOnly',
      },
    ]);

    expect(cors?.value).toBe('true');

    expect(setCookie?.value).toBe(
      `probe=${REDACTED}; Max-Age=0; Priority=High; Partitioned; Secure; HttpOnly`,
    );

    const output =
      '{"host":"jsonplaceholder.typicode.com","completed":true,"note":"untrue: High tide"}';

    expect(redactor.redactText(output)).toBe(output);

    expect(
      redactor.redactKnownSubstrings(
        'https://jsonplaceholder.typicode.com/posts/1',
        MIN_KNOWN_LENGTH,
      ),
    ).toBe('https://jsonplaceholder.typicode.com/posts/1');

    expect(redactor.redactText('ctl-bearer-value-0001 ctl-xauth-value-0002 secretvalue123')).toBe(
      `${REDACTED} ${REDACTED} ${REDACTED}`,
    );
  });

  it('keeps custom access-control headers and cookie values secret', () => {
    const redactor = new SecretRedactor();
    const [custom] = redactor.protectHeaders([
      { name: 'access-control-token', value: 'ctl-acctoken-value-0003' },
    ]);

    const [requestCookie] = redactor.protectHeaders([
      { name: 'Cookie', value: 'priority=ctlcookie01; secure=ctlcookie02' },
    ]);

    const [setCookie] = redactor.protectHeaders([
      { name: 'Set-Cookie', value: 'secure=ctlcookie03; Path=/' },
    ]);

    const [attributes] = redactor.protectHeaders([
      {
        name: 'Set-Cookie',
        value: 'sid=ctlcookie04; Secure=true; HttpOnly=true; Partitioned=true',
      },
    ]);

    expect(custom?.value).toBe(REDACTED);
    expect(requestCookie?.value).toBe(`priority=${REDACTED}; secure=${REDACTED}`);
    expect(setCookie?.value).toBe(`secure=${REDACTED}; Path=/`);
    expect(attributes?.value).toBe(`sid=${REDACTED}; Secure=true; HttpOnly=true; Partitioned=true`);
  });

  it('protects every newline-joined set-cookie line', () => {
    const [cookies] = new SecretRedactor().protectHeaders([
      { name: 'Set-Cookie', value: 'a=ctlcookie05; Priority=High\nb=ctlcookie06; Path=/' },
    ]);

    expect(cookies?.value).toBe(`a=${REDACTED}; Priority=High\nb=${REDACTED}; Path=/`);
  });

  it('hides API keys, cookies and Location credentials together', () => {
    const values = new SecretRedactor()
      .protectHeaders([
        { name: 'Authorization', value: 'Bearer abc.def.ghi-1234567890' },
        { name: 'Cookie', value: 'sid=s3cr3tvalue; theme=dark' },
        { name: 'Set-Cookie', value: 'sid=s3cr3tvalue; Path=/; HttpOnly\nother=1' },
        { name: 'X-Api-Key', value: 'k-123' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Location', value: 'https://x.test/cb?code=abc&state=ok' },
      ])
      .map(({ value }) => value);

    expect(values).toEqual([
      `Bearer ${REDACTED}`,
      `sid=${REDACTED}; theme=${REDACTED}`,
      `sid=${REDACTED}; Path=/; HttpOnly\nother=${REDACTED}`,
      REDACTED,
      'application/json',
      `https://x.test/cb?code=${REDACTED}&state=ok`,
    ]);
  });
});

describe('URLs (sidekick-18 req. 6.3)', () => {
  it('hides a token in a query string and leaves the rest of the URL alone', () => {
    const url = new SecretRedactor().protectUrl(
      'https://api.example.com/v1/items?access_token=tok_live_ABCDEF1234567890&page=2',
    );

    expect(url).toBe(`https://api.example.com/v1/items?access_token=${REDACTED}&page=2`);
  });

  it('hides secret-named query and fragment fields, and keeps relative URLs relative', () => {
    const redactor = new SecretRedactor();

    expect(
      redactor.protectUrl('https://api.test/v1/items?access_token=xyz&page=2#id_token=abc&tab=1'),
    ).toBe(`https://api.test/v1/items?access_token=${REDACTED}&page=2#id_token=${REDACTED}&tab=1`);

    expect(redactor.protectUrl('/relative?session=1')).toBe(`/relative?session=${REDACTED}`);

    expect(redactor.protectUrl('https://x.test/app#/settings/token-help')).toBe(
      'https://x.test/app#/settings/token-help',
    );
  });

  it('hides token-like path segments', () => {
    const redactor = new SecretRedactor();
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    expect(redactor.protectUrl(`https://example.com/reset/${jwt}/confirm`)).toBe(
      `https://example.com/reset/${REDACTED}/confirm`,
    );

    expect(redactor.redactText(`see ${jwt}`)).toBe(`see ${REDACTED}`);
  });

  it('leaves ordinary path segments and UUIDs alone', () => {
    const redactor = new SecretRedactor();

    expect(looksLikeToken('how-to-install-the-extension')).toBe(false);
    expect(looksLikeToken('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(looksLikeToken('0123456789abcdef0123456789abcdef')).toBe(true);

    expect(redactor.protectUrl('https://x.test/docs/how-to-install-the-extension-now')).toBe(
      'https://x.test/docs/how-to-install-the-extension-now',
    );

    expect(redactor.protectUrl('https://x.test/items/123e4567-e89b-12d3-a456-426614174000')).toBe(
      'https://x.test/items/123e4567-e89b-12d3-a456-426614174000',
    );
  });

  it('protects a :path header like the request URL', () => {
    const [path, authority] = new SecretRedactor().protectHeaders([
      { name: ':path', value: '/callback?code=4%2f0ax4xfwi6abcdef789' },
      { name: ':authority', value: 'docs.example.com' },
    ]);

    expect(path?.value).toBe(`/callback?code=${REDACTED}`);
    expect(authority?.value).toBe('docs.example.com');
  });
});

describe('bodies (sidekick-18 req. 6.4)', () => {
  it('hides structured fields in JSON, form and multipart bodies', () => {
    const redactor = new SecretRedactor();
    const multipart =
      '--b\r\nContent-Disposition: form-data; name="otp"\r\n\r\n123456\r\n--b\r\nContent-Disposition: form-data; name="q"\r\n\r\nhi\r\n--b--\r\n';

    expect(
      redactor.protectBody(
        '{"user":"dax","password":"hunter2","nested":{"refresh_token":"r-1"},"n":1}',
        'application/json',
      ),
    ).toBe(
      `{"user":"dax","password":"${REDACTED}","nested":{"refresh_token":"${REDACTED}"},"n":1}`,
    );

    expect(
      redactor.protectBody('user=dax&password=hunter2', 'application/x-www-form-urlencoded'),
    ).toBe(`user=dax&password=${REDACTED}`);

    expect(redactor.protectBody(multipart, 'multipart/form-data; boundary=b')).toBe(
      multipart.replace('123456', REDACTED),
    );
  });

  it('keeps out bodies it cannot parse safely, and multipart bodies with files', () => {
    const redactor = new SecretRedactor();
    const file =
      '--b\r\nContent-Disposition: form-data; name="doc"; filename="a.txt"\r\n\r\ntoken=abc\r\n--b--\r\n';

    expect(redactor.protectBody('not json', 'application/json')).toBeUndefined();
    expect(redactor.protectBody('<html>', 'text/html')).toBeUndefined();
    expect(redactor.protectBody(file, 'multipart/form-data; boundary=b')).toBeUndefined();
    expect(redactor.protectBody('x', 'multipart/form-data')).toBeUndefined();
  });

  it('hides typed passwords and one-time codes', () => {
    const redactor = new SecretRedactor();

    expect(
      redactor.protectBody(
        'username=ada&password=correct-horse-battery&otp=492817',
        'application/x-www-form-urlencoded',
      ),
    ).toBe(`username=ada&password=${REDACTED}&otp=${REDACTED}`);

    expect(
      JSON.parse(
        redactor.protectBody(
          JSON.stringify({ user: 'ada', passcode: '9988-7766' }),
          'application/json',
        ) ?? '{}',
      ),
    ).toEqual({ user: 'ada', passcode: REDACTED });

    expect(redactor.redactKnownSubstrings('echo correct-horse-battery', MIN_KNOWN_LENGTH)).toBe(
      `echo ${REDACTED}`,
    );
  });

  it('hides reusable credentials from a JSON body', () => {
    const redactor = new SecretRedactor();
    const body = redactor.protectBody(
      JSON.stringify({ data: { access_token: 'at_1234567890abcdef', name: 'ada' } }),
      'application/json',
    );

    expect(JSON.parse(body ?? '{}')).toEqual({ data: { access_token: REDACTED, name: 'ada' } });

    expect(redactor.redactKnownSubstrings('token at_1234567890abcdef', MIN_KNOWN_LENGTH)).toBe(
      `token ${REDACTED}`,
    );
  });

  it('keeps documentation code listings and inline code', () => {
    const listing = {
      type: 'codeListing',
      syntax: 'swift',
      code: ['struct MyView: View {', '    var body: some View {', '}', '', 'UInt8'],
    };

    const inline = {
      inlineContent: [
        { type: 'codeVoice', code: 'some View' },
        { type: 'codeVoice', code: 'UInt8' },
      ],
    };

    expect(json(listing)).toEqual(listing);
    expect(json(inline)).toEqual(inline);
  });

  it('keeps hiding code values outside documentation context', () => {
    const opaque = [
      'a7k2m9',
      'WDJB-MJHT',
      '4%2F0AX4XfWi6abcDEF789ghi',
      '123 456',
      'Basic dXNlcjpwYXNz',
      'Your code is 492817',
      'dG9rZW5fMTIzNDU2Nzg=',
      '{"token":"sk_live_123"}',
      'x = 1',
    ];

    for (const value of opaque) expect(json({ code: value })).toEqual({ code: REDACTED });

    expect(json({ code: ['WDJB MJHT', 'dG9rZW4x=='] })).toEqual({ code: [REDACTED, REDACTED] });
    expect(json({ Code: 'dG9rZW5fMTIzNDU2Nzg=' })).toEqual({ Code: REDACTED });
    expect(json({ code: 492817 })).toEqual({ code: REDACTED });

    expect(
      json({ user_code: 'WDJB-MJHT', device_code: 'GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS' }),
    ).toEqual({ user_code: REDACTED, device_code: REDACTED });

    expect(json({ code: { value: 'a7k2m9' } })).toEqual({ code: { value: REDACTED } });
    expect(json({ code: [{ value: 'a7k2m9' }] })).toEqual({ code: [{ value: REDACTED }] });

    expect(json({ type: 'codeVoice', CODE: 'secret' })).toEqual({
      type: 'codeVoice',
      CODE: REDACTED,
    });

    expect(json({ type: 'codeVoice', code: ['a7k2m9'] })).toEqual({
      type: 'codeVoice',
      code: [REDACTED],
    });

    expect(json({ type: 'codeListing', code: 'a7k2m9' })).toEqual({
      type: 'codeListing',
      code: REDACTED,
    });

    expect(json({ type: 'codeListing', code: ['ok line', { value: 'a7k2m9' }] })).toEqual({
      type: 'codeListing',
      code: ['ok line', { value: REDACTED }],
    });

    expect(json({ type: 'codeVoice', code: 'x', token: 'abc' })).toEqual({
      type: 'codeVoice',
      code: 'x',
      token: REDACTED,
    });

    const request = new SecretRedactor();

    expect(
      request.protectBody(
        'grant_type=authorization_code&code=4%2F0AX4XfWi6abcDEF789',
        'application/x-www-form-urlencoded',
      ),
    ).toBe(`grant_type=authorization_code&code=${REDACTED}`);

    expect(
      request.protectUrl('https://auth.example.com/callback?code=4%2F0AX4XfWi6abcDEF789'),
    ).toBe(`https://auth.example.com/callback?code=${REDACTED}`);
  });
});

describe('remembered values (sidekick-18 req. 6, 7)', () => {
  it('does not replace short captured values inside unrelated text', () => {
    const redactor = new SecretRedactor();

    expect(redactor.protectUrl('https://api.example.com/v1/orders?session=42&page=2')).toBe(
      `https://api.example.com/v1/orders?session=${REDACTED}&page=2`,
    );

    expect(redactor.redactText('order 1423 at 4:42')).toBe('order 1423 at 4:42');
    expect(redactor.redactText('42')).toBe(REDACTED);
    expect(redactor.redactScalar(42)).toBe(REDACTED);
    expect(redactor.redactScalar(true)).toBe(true);
  });

  it('keeps replacing short one-time values and long captured values', () => {
    const redactor = new SecretRedactor();

    redactor.protectBody('username=bob&password=hunter1', 'application/x-www-form-urlencoded');
    redactor.protectBody(JSON.stringify({ otp: '123456' }), 'application/json');

    redactor.protectUrl(
      'https://api.example.com/?session=42&access_token=tok_live_ABCDEF1234567890',
    );

    expect(redactor.redactText('username=bob&password=hunter1')).toBe(
      `username=bob&password=${REDACTED}`,
    );

    expect(redactor.redactText('code 123456 ok')).toBe(`code ${REDACTED} ok`);

    expect(redactor.redactText('at 4:42 token tok_live_ABCDEF1234567890 end')).toBe(
      `at 4:42 token ${REDACTED} end`,
    );
  });

  it('finds a known secret again under a name that does not look secret', () => {
    const redactor = new SecretRedactor();

    redactor.protectHeaders([
      { name: 'Authorization', value: 'Bearer sk_test_SECRETVALUE1234567890' },
    ]);

    redactor.protectHeaders([{ name: 'X-Token', value: 'short' }]);

    expect(redactor.redactText('debug sk_test_SECRETVALUE1234567890 end')).toBe(
      `debug ${REDACTED} end`,
    );

    expect(
      redactor.redactKnownSubstrings(
        'https://example.com/cb?state=sk_test_SECRETVALUE1234567890',
        MIN_KNOWN_LENGTH,
      ),
    ).toBe(`https://example.com/cb?state=${REDACTED}`);

    expect(redactor.redactText('a short word')).toBe('a short word');
  });

  it('finds a percent-encoded known secret', () => {
    const redactor = new SecretRedactor();

    redactor.protectUrl('https://example.com/?token=a%2Fb%2Bc1234567890');

    expect(redactor.redactKnownSubstrings('next=a%2Fb%2Bc1234567890', MIN_KNOWN_LENGTH)).toBe(
      `next=${REDACTED}`,
    );
  });

  it('keeps remembered values to their own redactor', () => {
    const first = new SecretRedactor();

    first.protectHeaders([{ name: 'Authorization', value: 'Bearer tab-one-secret-value' }]);

    expect(new SecretRedactor().redactText('tab-one-secret-value')).toBe('tab-one-secret-value');
  });
});
