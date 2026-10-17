// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { createPermissionEngine } from '../permission/engine';
import { BUILTIN_MODES, type PermissionMode } from '../permission/modes';
import { createRegistry } from '../registry/registry';
import { blockedSites } from '../storage/items';
import { installFakeChrome } from '../testing/fakeChrome';
import { type PermissionRequest, type ToolContext, ToolError, UNTRUSTED } from '../tool/tool';
import { privateHost } from './address';
import { htmlToMarkdown, htmlToText } from './markdown';
import { WEBFETCH_MAX_BYTES, webfetchTool } from './tool';

const PAGE = `<!doctype html><html><head><title>What's new</title><style>p{}</style></head><body>
<nav><a href="/">Home</a></nav>
<h1>What's new in <em>Chrome 142</em></h1>
<p>Extensions get <strong>new APIs</strong> and a <a href="/docs/side-panel">side panel</a> change.</p>
<script>alert('x')</script>
<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>
<ol start="3"><li>Third</li></ol>
<pre><code class="language-js">chrome.sidePanel.open();
</code></pre>
<p>Use <code>tabGroups</code>.</p>
<blockquote><p>Quoted</p></blockquote>
<table><tr><th>API</th><th>Version</th></tr><tr><td>sidePanel</td><td>142</td></tr></table>
<img src="/logo.png" alt="Logo">
</body></html>`;

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function respond(
  body: string,
  {
    type = 'text/html; charset=utf-8',
    status = 200,
    url,
  }: { type?: string; status?: number; url?: string } = {},
) {
  const sent: Sent[] = [];

  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init });

    const response = new Response(body, { status, headers: { 'content-type': type } });

    Object.defineProperty(response, 'url', { value: url ?? String(input) });

    return Promise.resolve(response);
  };

  return { sent, fetch };
}

function context(assert: (request: PermissionRequest) => Promise<void> = () => Promise.resolve()) {
  const requests: PermissionRequest[] = [];

  const ctx: ToolContext = {
    signal: new AbortController().signal,
    session: { id: 'ses-1' },
    messageID: 'msg-1',
    callID: 'call-1',
    agent: 'research',
    permission: {
      assert: (request) => {
        requests.push(request);

        return assert(request);
      },
    },
  };

  return { ctx, requests };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  if (!(error instanceof ToolError)) throw new Error(`Expected a ToolError, got ${String(error)}`);

  return error;
}

const input = (url: string, format: 'markdown' | 'text' | 'html' = 'markdown') => ({ url, format });

beforeEach(() => {
  installFakeChrome();
});

describe('webfetch', () => {
  it('returns a page as markdown, marked untrusted, with no cookies sent', async () => {
    const { sent, fetch } = respond(PAGE);
    const { ctx, requests } = context();
    const url = 'https://developer.chrome.com/docs/whats-new';
    const result = await webfetchTool({ fetch }).execute(input(url), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.init).toMatchObject({ credentials: 'omit', redirect: 'follow', method: 'GET' });
    expect(requests).toEqual([{ action: 'webfetch', resource: 'https://developer.chrome.com' }]);

    expect(result.output).toEqual({
      url,
      contentType: 'text/html; charset=utf-8',
      format: 'markdown',
    });

    expect(result.content?.[0]).toEqual({ type: 'text', text: UNTRUSTED });

    const markdown = result.content?.[1]?.type === 'text' ? result.content[1].text : '';

    expect(markdown).toContain("# What's new in _Chrome 142_");

    expect(markdown).toContain(
      'Extensions get **new APIs** and a [side panel](https://developer.chrome.com/docs/side-panel) change.',
    );

    expect(markdown).toContain('- One\n   - Nested\n- Two');
    expect(markdown).toContain('3. Third');
    expect(markdown).toContain('```js\nchrome.sidePanel.open();\n```');
    expect(markdown).toContain('Use `tabGroups`.');
    expect(markdown).toContain('> Quoted');
    expect(markdown).toContain('| API | Version |\n| --- | --- |\n| sidePanel | 142 |');
    expect(markdown).toContain('![Logo](https://developer.chrome.com/logo.png)');
    expect(markdown).not.toContain('alert');
    expect(markdown).not.toContain('p{}');
  });

  it('returns text or raw HTML when asked, and plain text as it is', async () => {
    const page = respond(PAGE);
    const tool = webfetchTool({ fetch: page.fetch });
    const text = await tool.execute(input('https://a.example/', 'text'), context().ctx);
    const html = await tool.execute(input('https://a.example/', 'html'), context().ctx);
    const plain = await webfetchTool({
      fetch: respond('Just text', { type: 'text/plain' }).fetch,
    }).execute(input('https://a.example/notes.txt'), context().ctx);

    expect(text.content?.[1]).toEqual({
      type: 'text',
      text: expect.stringContaining('Extensions get new APIs'),
    });

    expect(JSON.stringify(text.content)).not.toContain('alert');
    expect(html.content?.[1]).toEqual({ type: 'text', text: PAGE });
    expect(plain.content?.[1]).toEqual({ type: 'text', text: 'Just text' });
  });

  it.each([
    [
      'http://192.168.1.1/',
      'webfetch only reads public web pages: 192.168.1.1 is a local or private address',
    ],
    ['file:///etc/passwd', 'URL must use http:// or https://'],
    ['http://localhost:8080/admin', 'localhost is a local network name'],
    ['http://user:pass@example.com/', 'must not include a username or password'],
  ])('refuses %s before any request', async (url, message) => {
    const { sent, fetch } = respond('secret');
    const { ctx, requests } = context();
    const error = await failure(webfetchTool({ fetch }).execute(input(url), ctx));

    expect(error.code).toBe('invalid_target');
    expect(error.message).toContain(message);
    expect(sent).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('refuses a redirect that ends on a private address, without reading it', async () => {
    const { fetch } = respond('router admin', { url: 'http://10.0.0.1/admin' });
    const error = await failure(
      webfetchTool({ fetch }).execute(input('https://short.example/x'), context().ctx),
    );

    expect(error.code).toBe('invalid_target');
    expect(error.message).toContain('10.0.0.1 is a local or private address');
    expect(error.message).not.toContain('router admin');
  });

  it('asserts webfetch again on the site a redirect lands on', async () => {
    const { fetch } = respond('<p>ok</p>', { url: 'https://landing.example/page' });
    const { ctx, requests } = context();
    const result = await webfetchTool({ fetch }).execute(input('https://short.example/x'), ctx);

    expect(requests.map(({ resource }) => resource)).toEqual([
      'https://short.example',
      'https://landing.example',
    ]);

    expect(result.output.url).toBe('https://landing.example/page');
  });

  it('is denied on a blocked site', async () => {
    const agents = createRegistry<AgentInfo>('agents');
    const modes = createRegistry<PermissionMode>('permissionModes');

    agents.register('builtin', (draft) => {
      for (const agent of BUILTIN_AGENTS) draft.add(agent);
    });

    modes.register('builtin', (draft) => {
      for (const mode of BUILTIN_MODES) draft.add(mode);
    });

    const engine = createPermissionEngine({ agents, modes, emit: () => undefined });
    const scope = { sessionID: 'ses-1', messageID: 'msg-1', callID: 'call-1', agent: 'research' };

    await blockedSites.set([{ site: 'blocked.example', created: 1 }]);

    const { sent, fetch } = respond('<p>no</p>');
    const { ctx } = context((request) => engine.assert(request, scope));
    const error = await failure(
      webfetchTool({ fetch }).execute(input('https://www.blocked.example/'), ctx),
    );

    expect(error.code).toBe('denied');
    expect(sent).toEqual([]);
  });

  it('fails on an error status, an image, a binary type and an oversized body', async () => {
    const cases = [
      respond('gone', { status: 404 }),
      respond('png', { type: 'image/png' }),
      respond('zip', { type: 'application/zip' }),
      respond('x'.repeat(WEBFETCH_MAX_BYTES + 1), { type: 'text/plain' }),
    ];

    const messages = await Promise.all(
      cases.map(
        async ({ fetch }) =>
          (
            await failure(
              webfetchTool({ fetch }).execute(input('https://a.example/'), context().ctx),
            )
          ).message,
      ),
    );

    expect(messages).toEqual([
      'Unable to fetch https://a.example/: HTTP 404',
      'Unable to fetch https://a.example/: unsupported content type image/png',
      'Unable to fetch https://a.example/: unsupported content type application/zip',
      `Unable to fetch https://a.example/: the response exceeds the ${WEBFETCH_MAX_BYTES} byte limit`,
    ]);
  });

  it('turns a network failure into a request_failed tool error', async () => {
    const error = await failure(
      webfetchTool({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) }).execute(
        input('https://down.example/'),
        context().ctx,
      ),
    );

    expect(error).toMatchObject({
      code: 'request_failed',
      message: 'Unable to fetch https://down.example/: the request failed',
    });
  });
});

describe('private hosts', () => {
  it.each([
    'http://localhost/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://router/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.10/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fd12:3456::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[64:ff9b::a00:1]/',
    'http://localhost./',
  ])('refuses %s', (url) => {
    expect(privateHost(new URL(url))).toBeDefined();
  });

  it.each([
    'https://example.com/',
    'https://developer.chrome.com/',
    'http://8.8.8.8/',
    'http://172.32.0.1/',
    'http://100.128.0.1/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:8.8.8.8]/',
  ])('allows %s', (url) => {
    expect(privateHost(new URL(url))).toBeUndefined();
  });
});

describe('html conversion', () => {
  it('keeps only http(s) links and drops script and style text', () => {
    expect(
      htmlToMarkdown(
        '<p><a href="javascript:alert(1)">Click</a> <a href="mailto:a@b.c">Mail</a></p>',
        'https://a.example/',
      ),
    ).toBe('Click Mail');

    expect(htmlToText('<p>Hi<script>x()</script><style>p{}</style> there</p>')).toBe('Hi there');
  });
});
