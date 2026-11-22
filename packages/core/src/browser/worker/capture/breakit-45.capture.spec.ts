import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeCdp, MAIN_FRAME } from '../fakes';
import { drain, failure, setupBrowser } from '../harness';
import { captureConsole } from './console';
import { SecretRedactor } from './redact';

type Setup = Awaited<ReturnType<typeof setupBrowser>>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function call(setup: Setup, id: string, input: Record<string, unknown>) {
  const tool = setup.tool(id);

  return drain(tool.execute(tool.input.parse({ tab_id: 1, ...input }), setup.ctx));
}

async function output(setup: Setup, id: string, input: Record<string, unknown>) {
  const { output: result } = await call(setup, id, input);

  return result as Record<string, unknown> & { entries: Record<string, unknown>[] };
}

function pageContext(setup: Setup, id = 7) {
  setup.cdp.emit({
    tabId: 1,
    method: 'Runtime.executionContextCreated',
    params: { context: { id, auxData: { isDefault: true, frameId: MAIN_FRAME } } },
  });
}

function logArgs(setup: Setup, args: Record<string, unknown>[]) {
  setup.cdp.emit({
    tabId: 1,
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log', args, executionContextId: 7, timestamp: Date.now() },
  });
}

function log(setup: Setup, text: string) {
  logArgs(setup, [{ type: 'string', value: text }]);
}

function emit(setup: Setup, method: string, params: Record<string, unknown>) {
  setup.cdp.emit({ tabId: 1, method, params });
}

function fetchOk(setup: Setup, id: string, url: string) {
  emit(setup, 'Network.requestWillBeSent', {
    requestId: id,
    frameId: MAIN_FRAME,
    type: 'Fetch',
    wallTime: Date.now() / 1000,
    timestamp: 1,
    request: { url, method: 'GET', headers: {} },
  });

  emit(setup, 'Network.responseReceived', {
    requestId: id,
    type: 'Fetch',
    response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' },
  });

  emit(setup, 'Network.loadingFinished', {
    requestId: id,
    timestamp: 1.25,
    encodedDataLength: 100,
  });
}

describe('breakit-45: console text pattern pass (PR body; spec req. 6)', () => {
  it('hides values after secret-like names that hold spaces, commas, ampersands or escaped quotes', async () => {
    const setup = await setupBrowser();
    const secrets = [
      'p@ss,word!',
      'correct horse battery',
      'abc;defghij',
      'Tr0ub4dor&3xyz',
      'abc\\"defgh',
    ];

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);
    log(setup, JSON.stringify({ password: secrets[0] }));
    log(setup, JSON.stringify({ password: secrets[1] }));
    log(setup, `password=${secrets[2]}`);
    log(setup, JSON.stringify({ user: 'ada', password: secrets[3] }));
    log(setup, '{"access_token":"abc\\"defgh"}');

    const read = await output(setup, 'console_capture', { action: 'read' });
    const texts = read.entries.map((entry) => String(entry.text));

    for (const [index, secret] of secrets.entries()) {
      const tail = secret.split(/[ ,;&\\]/).at(-1) ?? secret;

      expect.soft(texts[index], `entry ${index}`).not.toContain(tail);
    }
  });

  it('hides a secret-named field inside a JSON string an object property holds', async () => {
    const setup = await setupBrowser();
    const token = 'tok_9f8e7d6c5b4a3921';

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);

    logArgs(setup, [
      { type: 'string', value: 'sending' },
      {
        type: 'object',
        preview: {
          type: 'object',
          description: 'Object',
          overflow: false,
          properties: [
            { name: 'url', type: 'string', value: '/api/save' },
            { name: 'body', type: 'string', value: JSON.stringify({ token }) },
          ],
        },
      },
    ]);

    const read = await output(setup, 'console_capture', { action: 'read' });

    expect(read.entries[0]?.text).toContain('/api/save');
    expect(read.entries[0]?.text).not.toContain(token);
  });
});

describe('breakit-45: an ended capture keeps what it left unread (PR body; spec req. 4)', () => {
  it('a restart that fails because DevTools still holds the tab keeps the unread entries and why it ended', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);
    log(setup, 'the clue');
    setup.cdp.detachByChrome(1, 'replaced_with_devtools');
    await vi.advanceTimersByTimeAsync(0);

    setup.cdp.attachErrors.push(
      new Error('Another debugger is already attached to the tab with id: 1.'),
    );

    expect(await failure(call(setup, 'console_capture', { action: 'start' }))).toMatchObject({
      code: 'attach_blocked',
    });

    const read = await output(setup, 'console_capture', { action: 'read' });

    expect(read).toMatchObject({ capturing: false, ended: 'devtools_opened' });
    expect(read.entries.map(({ text }) => text)).toEqual(['the clue']);
  });

  it('after the tab closes, the next read says the capture ended because the tab closed', async () => {
    const setup = await setupBrowser();

    await call(setup, 'network_capture', { action: 'start' });
    fetchOk(setup, 'a', 'https://example.com/api/a');
    setup.tabs.tabs.delete(1);
    setup.cdp.detachByChrome(1, 'target_closed');
    await vi.advanceTimersByTimeAsync(0);

    const read = await output(setup, 'network_capture', { action: 'read' });

    expect(read).toMatchObject({ capturing: false, ended: 'tab_closed' });
    expect(read.entries).toHaveLength(1);
  });
});

describe('breakit-45: a read returns what arrived since the last read (spec req. 5; PR body)', () => {
  it('a newest entry over the reply size is not lost together with every earlier entry', async () => {
    const setup = await setupBrowser();

    setup.cdp.replies.set('Network.getResponseBody', ({ requestId }) => ({
      body: JSON.stringify({ data: requestId === 'big' ? 'x'.repeat(40_000) : 'small' }),
    }));

    await call(setup, 'network_capture', { action: 'start', bodies: true });
    fetchOk(setup, 'small', 'https://example.com/api/small');
    fetchOk(setup, 'big', 'https://example.com/api/big');
    await vi.advanceTimersByTimeAsync(0);

    const read = await output(setup, 'network_capture', { action: 'read' });
    const later = await output(setup, 'network_capture', { action: 'read' });
    const seen = [...read.entries, ...later.entries].map(({ url }) => url);

    expect(seen).toEqual(['https://example.com/api/small', 'https://example.com/api/big']);
  });
});

describe('a read that doesn’t fit the reply keeps the rest', () => {
  it('cuts a long body and keeps it readable', async () => {
    const setup = await setupBrowser();

    setup.cdp.replies.set('Network.getResponseBody', () => ({
      body: JSON.stringify({ data: 'x'.repeat(40_000) }),
    }));

    await call(setup, 'network_capture', { action: 'start', bodies: true });
    fetchOk(setup, 'big', 'https://example.com/api/big');
    await vi.advanceTimersByTimeAsync(0);

    const read = await output(setup, 'network_capture', { action: 'read' });
    const [entry] = read.entries;

    expect(String(entry?.response_body)).toHaveLength(20_000);
    expect(entry?.response_body_cut).toBe(40_011 - 20_000);
  });

  it('a stop that can’t return everything leaves the older entries for a read', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);

    for (let index = 0; index < 15; index++) log(setup, `${index}`.padEnd(3_000, '.'));

    const stopped = await output(setup, 'console_capture', { action: 'stop' });
    const rest = await output(setup, 'console_capture', { action: 'read' });
    const texts = [...rest.entries, ...stopped.entries].map(
      ({ text }) => String(text).split('.')[0],
    );

    expect(stopped).toMatchObject({ capturing: false, truncated: true });
    expect(rest).toMatchObject({ capturing: false, truncated: false });
    expect(texts).toEqual(Array.from({ length: 15 }, (_, index) => `${index}`));

    expect(await failure(call(setup, 'console_capture', { action: 'read' }))).toMatchObject({
      code: 'invalid_target',
    });
  });
});

describe('breakit-45: main frame only (spec req. 9; console_capture description)', () => {
  it('leaves out browser log entries that come from a worker', async () => {
    const setup = await setupBrowser();

    await call(setup, 'console_capture', { action: 'start' });
    pageContext(setup);

    emit(setup, 'Log.entryAdded', {
      entry: {
        source: 'worker',
        level: 'error',
        text: 'worker boom',
        workerId: 'worker-1',
        timestamp: Date.now(),
      },
    });

    const read = await output(setup, 'console_capture', { action: 'read' });

    expect(read.entries).toEqual([]);
  });
});

describe('breakit-45: bodies over 1 MB are kept out whole (PR body; MAX_BODY_BYTES)', () => {
  it('measures the 1 MB limit in bytes, not UTF-16 characters', async () => {
    const setup = await setupBrowser();
    const body = JSON.stringify({ note: '€'.repeat(400_000) });

    expect(new TextEncoder().encode(body).length).toBeGreaterThan(1_000_000);

    setup.cdp.replies.set('Network.getResponseBody', () => ({ body }));

    await call(setup, 'network_capture', { action: 'start', bodies: true });
    fetchOk(setup, 'euro', 'https://example.com/api/euro');
    await vi.advanceTimersByTimeAsync(0);

    const { entries } = setup.runtime.env.captures.read(1, 'network') ?? { entries: [] };

    expect(entries[0]?.response?.body).toMatchObject({ omitted: 'size' });
  });
});

describe('breakit-45: redaction runs before an entry is stored (spec req. 6, 7)', () => {
  it('the stored text of an exception hides the path token its url field hides', () => {
    const cdp = fakeCdp([]);
    const token = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
    const url = `https://cdn.example.com/u/${token}/app.js`;
    const capture = captureConsole({
      cdp,
      tabId: 1,
      frameId: MAIN_FRAME,
      redactor: new SecretRedactor(),
    });

    cdp.emit({
      tabId: 1,
      method: 'Runtime.executionContextCreated',
      params: { context: { id: 7, auxData: { isDefault: true, frameId: MAIN_FRAME } } },
    });

    cdp.emit({
      tabId: 1,
      method: 'Runtime.exceptionThrown',
      params: {
        timestamp: 1,
        exceptionDetails: {
          executionContextId: 7,
          url,
          lineNumber: 2,
          text: 'Uncaught',
          exception: {
            type: 'object',
            subtype: 'error',
            description: `Error: boom\n    at ${url}:3:7`,
          },
        },
      },
    });

    const [stored] = capture.take().entries;

    expect(stored?.url).not.toContain(token);
    expect(stored?.text).not.toContain(token);
  });
});
