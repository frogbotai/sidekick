import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UNTRUSTED } from '../../../tool/tool';
import { MAIN_FRAME } from '../fakes';
import { drain, failure, sentMethods, setupBrowser } from '../harness';
import { IDLE_DETACH_MS } from '../sessions';
import { CAPTURE_LIMIT } from './buffer';
import { CAPTURE_CAP_MS } from './index';
import { MAX_BODY_BYTES } from './network';

type Setup = Awaited<ReturnType<typeof setupBrowser>>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const CAPTURE_DOMAINS = new Set(['Runtime.enable', 'Log.enable', 'Runtime.disable', 'Log.disable']);

function domains(setup: Setup) {
  return sentMethods(setup.cdp.sent).filter((method) => CAPTURE_DOMAINS.has(method));
}

async function call(setup: Setup, id: string, input: Record<string, unknown>) {
  const tool = setup.tool(id);

  return drain(tool.execute(tool.input.parse({ tab_id: 1, ...input }), setup.ctx));
}

async function output(setup: Setup, id: string, input: Record<string, unknown>) {
  const { output: result } = await call(setup, id, input);

  return result as Record<string, unknown> & { entries: Record<string, unknown>[] };
}

function pageContext(setup: Setup, id = 7, frameId = MAIN_FRAME, isDefault = true) {
  setup.cdp.emit({
    tabId: 1,
    method: 'Runtime.executionContextCreated',
    params: { context: { id, auxData: { isDefault, frameId } } },
  });
}

function log(setup: Setup, text: string, { type = 'log', context = 7 } = {}) {
  setup.cdp.emit({
    tabId: 1,
    method: 'Runtime.consoleAPICalled',
    params: {
      type,
      args: [{ type: 'string', value: text }],
      executionContextId: context,
      timestamp: Date.now(),
    },
  });
}

interface Request {
  id: string;
  url: string;
  method?: string;
  frameId?: string;
  headers?: Record<string, string>;
  postData?: string;
  status?: number;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  extraRequest?: Record<string, string>;
  extraResponse?: Record<string, string>;
  failure?: string;
}

function request(setup: Setup, item: Request) {
  const emit = (method: string, params: Record<string, unknown>) =>
    setup.cdp.emit({ tabId: 1, method, params: { requestId: item.id, ...params } });

  emit('Network.requestWillBeSent', {
    frameId: item.frameId ?? MAIN_FRAME,
    type: 'Fetch',
    wallTime: Date.now() / 1000,
    timestamp: 1,
    request: {
      url: item.url,
      method: item.method ?? 'GET',
      headers: item.headers ?? {},
      ...(item.postData ? { postData: item.postData, hasPostData: true } : {}),
    },
  });

  if (item.extraRequest) emit('Network.requestWillBeSentExtraInfo', { headers: item.extraRequest });

  if (item.failure) {
    emit('Network.loadingFailed', { timestamp: 1.5, errorText: item.failure });

    return;
  }

  emit('Network.responseReceived', {
    type: 'Fetch',
    response: {
      status: item.status ?? 200,
      statusText: 'OK',
      headers: item.responseHeaders ?? {},
      mimeType: item.mimeType ?? 'application/json',
    },
  });

  if (item.extraResponse) {
    emit('Network.responseReceivedExtraInfo', { headers: item.extraResponse });
  }

  emit('Network.loadingFinished', { timestamp: 1.25, encodedDataLength: 100 });
}

describe('console capture turns detectable domains on only while it runs (sidekick-18 req. 3)', () => {
  it('sends nothing before start, both enables on start and both disables on stop', async () => {
    const setup = await setupBrowser();

    await call(setup, 'click', { ref: 'f0e1' });
    await call(setup, 'network_capture', { action: 'start' });

    expect(domains(setup)).toEqual([]);

    await call(setup, 'console_capture', { action: 'start' });

    expect(domains(setup)).toEqual(['Runtime.enable', 'Log.enable']);

    await call(setup, 'console_capture', { action: 'stop' });

    expect(domains(setup)).toEqual([
      'Runtime.enable',
      'Log.enable',
      'Runtime.disable',
      'Log.disable',
    ]);
  });

  it('disables on detach, and the next read says why it ended', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);
    log(setup, 'before close');
    setup.cdp.detachByChrome(1, 'target_closed');
    await vi.advanceTimersByTimeAsync(0);

    expect(domains(setup)).toEqual([
      'Runtime.enable',
      'Log.enable',
      'Runtime.disable',
      'Log.disable',
    ]);

    const read = await output(setup, 'console_capture', { action: 'read' });

    expect(read).toMatchObject({ capturing: false, ended: 'tab_closed' });
    expect(read.entries.map(({ text }) => text)).toEqual(['before close']);

    expect(await failure(call(setup, 'console_capture', { action: 'read' }))).toMatchObject({
      code: 'invalid_target',
    });
  });

  it('keeps only the main frame’s page world, not content scripts or iframes', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup, 7);
    pageContext(setup, 8, MAIN_FRAME, false);
    pageContext(setup, 9, 'child-frame');
    log(setup, 'page', { context: 7 });
    log(setup, 'content script', { context: 8 });
    log(setup, 'iframe', { context: 9 });

    const read = await output(setup, 'console_capture', { action: 'read' });

    expect(read.entries.map(({ text }) => text)).toEqual(['page']);
  });
});

describe('a capture holds the debugger (sidekick-18 req. 1, 4)', () => {
  it('survives the idle detach, then ends at the 30-minute cap and lets the session go', async () => {
    const setup = await setupBrowser();

    await call(setup, 'network_capture', { action: 'start' });
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS);

    expect(setup.cdp.detached).toEqual([]);

    await vi.advanceTimersByTimeAsync(CAPTURE_CAP_MS);

    const read = await output(setup, 'network_capture', { action: 'read' });

    expect(read).toMatchObject({ capturing: false, ended: 'time_limit' });

    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS);

    expect(setup.cdp.detached).toEqual([1]);
  });

  it('keeps the session while either capture of the tab runs', async () => {
    const setup = await setupBrowser();

    await call(setup, 'network_capture', { action: 'start' });
    await call(setup, 'console_capture', { action: 'start' });
    await call(setup, 'network_capture', { action: 'stop' });
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS * 2);

    expect(setup.cdp.detached).toEqual([]);

    await call(setup, 'console_capture', { action: 'stop' });
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS);

    expect(setup.cdp.detached).toEqual([1]);
  });
});

describe('reading a capture (sidekick-18 req. 2, 5)', () => {
  it('keeps the newest 1,000 entries and reports how many it dropped', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);

    for (let index = 0; index < CAPTURE_LIMIT + 5; index++) log(setup, `m${index}`);

    const read = setup.runtime.env.captures.read(1, 'console');

    expect(read?.dropped).toBe(5);
    expect(read?.entries).toHaveLength(CAPTURE_LIMIT);
    expect(read?.entries[0]?.text).toBe('m5');

    expect(setup.runtime.env.captures.read(1, 'console')).toMatchObject({
      entries: [],
      dropped: 0,
    });
  });

  it('returns only entries since the last read, filtered by level, newest kept when cut', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);
    log(setup, 'old');
    await output(setup, 'console_capture', { action: 'read' });
    log(setup, 'info');
    log(setup, 'bad', { type: 'error' });
    log(setup, 'careful', { type: 'warning' });

    const read = await output(setup, 'console_capture', { action: 'read', level: 'warning' });

    expect(read.entries.map(({ level, text }) => `${String(level)}:${String(text)}`)).toEqual([
      'error:bad',
      'warning:careful',
    ]);

    for (let index = 0; index < 20; index++) log(setup, `${index}`.padEnd(3_000, '.'));

    const cut = await output(setup, 'console_capture', { action: 'stop' });

    expect(cut.truncated).toBe(true);
    expect(cut.capturing).toBe(false);
    expect(cut.entries.at(-1)?.text).toMatch(/^19\./);
  });

  it('records failures, filters by URL and skips other frames', async () => {
    const setup = await setupBrowser();

    await call(setup, 'network_capture', { action: 'start' });
    request(setup, { id: 'a', url: 'https://example.com/api/save', method: 'POST', status: 422 });
    request(setup, { id: 'b', url: 'https://example.com/api/load', failure: 'net::ERR_FAILED' });
    request(setup, { id: 'c', url: 'https://ads.test/pixel', frameId: 'child-frame' });
    request(setup, { id: 'd', url: 'https://example.com/logo.png' });

    const read = await output(setup, 'network_capture', { action: 'read', url_contains: '/api/' });

    expect(read.entries).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: 'https://example.com/api/save',
        status: 422,
        ms: 250,
      }),
      expect.objectContaining({ url: 'https://example.com/api/load', failure: 'net::ERR_FAILED' }),
    ]);

    expect(read.entries[0]).not.toHaveProperty('request_headers');
  });

  it('starting twice keeps the running capture, and reading without one says to start', async () => {
    const setup = await setupBrowser();

    expect(await failure(call(setup, 'network_capture', { action: 'read' }))).toMatchObject({
      code: 'invalid_target',
      message: expect.stringContaining('action start first'),
    });

    expect(await output(setup, 'network_capture', { action: 'start' })).toMatchObject({
      started: true,
    });

    request(setup, { id: 'a', url: 'https://example.com/a' });

    expect(await output(setup, 'network_capture', { action: 'start' })).toMatchObject({
      started: false,
    });

    expect((await output(setup, 'network_capture', { action: 'stop' })).entries).toHaveLength(1);
  });
});

describe('captured data holds no raw secret (sidekick-18 req. 6, 8)', () => {
  it('hides headers, cookies, URL tokens, body fields and known values in console text', async () => {
    const setup = await setupBrowser();
    const secrets = {
      bearer: 'bearer-6e1f0c8a9b7d4e2f',
      cookie: 'cookie-9a8b7c6d5e4f3a2b',
      setCookie: 'setcookie-1a2b3c4d5e6f',
      query: 'querytoken-7f6e5d4c3b2a',
      password: 'hunter2-password-value',
      session: 'session-0f1e2d3c4b5a',
    };

    setup.cdp.replies.set('Network.getResponseBody', () => ({
      body: JSON.stringify({ session_token: secrets.session, ok: true }),
      base64Encoded: false,
    }));

    await call(setup, 'network_capture', { action: 'start', bodies: true });
    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);

    request(setup, {
      id: 'login',
      url: `https://example.com/login?access_token=${secrets.query}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.bearer}` },
      postData: JSON.stringify({ user: 'ada', password: secrets.password }),
      extraRequest: { Cookie: `sid=${secrets.cookie}` },
      extraResponse: { 'Set-Cookie': `next=${secrets.setCookie}; Path=/; HttpOnly` },
    });

    await vi.advanceTimersByTimeAsync(0);
    log(setup, `token is ${secrets.bearer}, session ${secrets.session}`);

    const network = await call(setup, 'network_capture', { action: 'stop', headers: true });
    const consoleRead = await call(setup, 'console_capture', { action: 'stop' });
    const text = JSON.stringify([network.output, consoleRead.output]);

    for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);

    expect(text).toContain('[redacted]');
    expect(text).toContain('\\"ok\\":true');
    expect(text).toContain('HttpOnly');
    expect(network.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });
    expect(consoleRead.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });
  });

  it('keeps a body over 1 MB out whole instead of cutting it', async () => {
    const setup = await setupBrowser();

    setup.cdp.replies.set('Network.getResponseBody', () => ({
      body: JSON.stringify({ data: 'x'.repeat(MAX_BODY_BYTES) }),
    }));

    await call(setup, 'network_capture', { action: 'start', bodies: true });
    request(setup, { id: 'big', url: 'https://example.com/big' });
    request(setup, { id: 'img', url: 'https://example.com/a.png', mimeType: 'image/png' });
    await vi.advanceTimersByTimeAsync(0);

    const read = await output(setup, 'network_capture', { action: 'read' });

    expect(read.entries).toEqual([
      expect.objectContaining({ url: 'https://example.com/a.png', response_body_omitted: 'type' }),
      expect.objectContaining({ url: 'https://example.com/big', response_body_omitted: 'size' }),
    ]);

    expect(
      sentMethods(setup.cdp.sent).filter((method) => method === 'Network.getResponseBody'),
    ).toHaveLength(1);
  });
});
