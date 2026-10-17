import { beforeEach, describe, expect, it, vi } from 'vitest';

import { credentials } from '../../provider/credentials';
import { searchProviders } from '../../registry';
import { installFakeChrome } from '../../testing/fakeChrome';
import { BUILTIN_SEARCH_PROVIDERS, registerBuiltinSearchProviders } from '../builtin';
import { SearchHttpError } from '../http';
import { exa, parseExaResults } from './exa';
import { firecrawl } from './firecrawl';
import { parallel } from './parallel';
import { tavily } from './tavily';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../../provider/fetch', () => ({ privateFetch: network }));

const signal = () => new AbortController().signal;

function mcp(result: unknown, sse = true) {
  const message = JSON.stringify({ jsonrpc: '2.0', id: 1, result });

  return sse
    ? new Response(`event: message\ndata: ${message}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    : new Response(message, { headers: { 'Content-Type': 'application/json' } });
}

function request() {
  const [url, init] = network.mock.calls[0] ?? [];

  return {
    url: String(url),
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
}

const addKey = (providerID: string, key: string) =>
  credentials.add({ providerID, label: 'Mine', value: { type: 'key', key } });

const EXA_TEXT = [
  'Title: Effect\nURL: https://effect.website\nPublished: 2026-07-25T00:00:00.000Z\nAuthor: N/A\nHighlights:\nEffect documentation',
  'Title: N/A\nURL: https://b.example\nPublished: N/A\nText: Body text',
  'Title: No URL here',
].join('\n\n---\n\n');

beforeEach(() => {
  installFakeChrome();
  network.mockReset();
});

describe('registerBuiltinSearchProviders', () => {
  it('registers Exa, Firecrawl, Parallel and Tavily, each taking an optional key', () => {
    const dispose = registerBuiltinSearchProviders();

    expect(searchProviders.list().map(({ id }) => id)).toEqual([
      'exa',
      'firecrawl',
      'parallel',
      'tavily',
    ]);

    expect(BUILTIN_SEARCH_PROVIDERS.every(({ key }) => key?.url.startsWith('https://'))).toBe(true);

    dispose();

    expect(searchProviders.list()).toEqual([]);
  });
});

describe('Exa', () => {
  it('calls web_search_exa keyless and maps the text blocks', async () => {
    network.mockResolvedValue(mcp({ content: [{ type: 'text', text: EXA_TEXT }] }));

    expect(await exa.search('effect', signal())).toEqual([
      {
        url: 'https://effect.website',
        title: 'Effect',
        content: 'Effect documentation',
        published: Date.parse('2026-07-25T00:00:00.000Z'),
      },
      { url: 'https://b.example', content: 'Body text' },
    ]);

    const { url, body } = request();

    expect(url).toBe('https://mcp.exa.ai/mcp');

    expect(body).toMatchObject({
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: 'effect', numResults: 8 } },
    });
  });

  it('puts the active key in the URL, and no error names it', async () => {
    await addKey('exa', 'exa-secret');
    network.mockResolvedValue(new Response('nope', { status: 401 }));

    const error = await exa.search('effect', signal()).catch((caught: unknown) => caught);

    expect(request().url).toBe('https://mcp.exa.ai/mcp?exaApiKey=exa-secret');
    expect(error).toBeInstanceOf(SearchHttpError);
    expect(String(error)).not.toContain('exa-secret');
    expect(JSON.stringify(error)).not.toContain('exa-secret');
  });

  it('uses the key active when the search runs', async () => {
    const first = await addKey('exa', 'one');
    const second = await addKey('exa', 'two');

    network.mockImplementation(() => Promise.resolve(mcp({ content: [] })));
    await credentials.activate(second.id);
    await exa.search('q', signal());
    await credentials.activate(first.id);
    await exa.search('q', signal());

    expect(network.mock.calls.map(([url]) => String(url))).toEqual([
      'https://mcp.exa.ai/mcp?exaApiKey=two',
      'https://mcp.exa.ai/mcp?exaApiKey=one',
    ]);
  });

  it('skips blocks with no URL and N/A fields', () => {
    expect(parseExaResults('Title: A')).toEqual([]);
  });
});

describe('Firecrawl', () => {
  const answer = {
    success: true,
    data: {
      web: [
        { url: 'https://a.example', title: 'A', description: 'About A' },
        { url: 'https://b.example', title: null, description: null },
      ],
    },
  };

  it('calls firecrawl_search keyless, over JSON or SSE, and maps data.web', async () => {
    for (const sse of [true, false]) {
      network.mockReset();

      network.mockResolvedValue(
        mcp({ content: [{ type: 'text', text: JSON.stringify(answer) }] }, sse),
      );

      expect(await firecrawl.search('q', signal())).toEqual([
        { url: 'https://a.example', title: 'A', content: 'About A' },
        { url: 'https://b.example' },
      ]);

      const { url, headers, body } = request();

      expect(url).toBe('https://mcp.firecrawl.dev/v2/mcp');
      expect(headers).not.toHaveProperty('Authorization');

      expect(body).toMatchObject({
        params: { name: 'firecrawl_search', arguments: { query: 'q', limit: 8 } },
      });
    }
  });

  it('sends the active key as a bearer token', async () => {
    await addKey('firecrawl', 'fc-key');
    network.mockResolvedValue(mcp({ content: [] }));

    expect(await firecrawl.search('q', signal())).toEqual([]);
    expect(request().headers).toMatchObject({ Authorization: 'Bearer fc-key' });
  });

  it('fails on an isError result instead of returning no results', async () => {
    network.mockResolvedValue(
      mcp({ isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] }),
    );

    await expect(firecrawl.search('q', signal())).rejects.toMatchObject({
      code: 'request_failed',
      message: 'firecrawl_search failed: Rate limit exceeded',
    });
  });
});

describe('Parallel', () => {
  const structuredContent = {
    search_id: 's',
    session_id: 's',
    results: [
      {
        url: 'https://a.example',
        title: 'A',
        publish_date: '2026-01-02',
        excerpts: ['one', 'two'],
      },
      { url: 'https://b.example', title: null, publish_date: null, excerpts: [] },
    ],
  };

  it('calls web_search keyless with the objective and maps structuredContent', async () => {
    network.mockResolvedValue(
      mcp({ content: [{ type: 'text', text: '' }], structuredContent }, false),
    );

    expect(await parallel.search('q', signal())).toEqual([
      {
        url: 'https://a.example',
        title: 'A',
        content: 'one\n\ntwo',
        published: Date.parse('2026-01-02'),
      },
      { url: 'https://b.example' },
    ]);

    const { url, headers, body } = request();

    expect(url).toBe('https://search.parallel.ai/mcp');
    expect(headers).not.toHaveProperty('Authorization');

    expect(body).toMatchObject({
      params: { name: 'web_search', arguments: { objective: 'q', search_queries: ['q'] } },
    });
  });

  it('sends the active key as a bearer token', async () => {
    await addKey('parallel', 'par-key');
    network.mockResolvedValue(mcp({ content: [], structuredContent }));

    await parallel.search('q', signal());

    expect(request().headers).toMatchObject({ Authorization: 'Bearer par-key' });
  });
});

describe('Tavily', () => {
  const answer = {
    results: [
      { title: 'A', url: 'https://a.example', content: 'About A' },
      { title: 'B', url: 'https://b.example', content: '' },
    ],
  };

  it('posts /search with the keyless header and maps results', async () => {
    network.mockResolvedValue(Response.json(answer));

    expect(await tavily.search('q', signal())).toEqual([
      { url: 'https://a.example', title: 'A', content: 'About A' },
      { url: 'https://b.example', title: 'B' },
    ]);

    const { url, headers, body } = request();

    expect(url).toBe('https://api.tavily.com/search');
    expect(headers).toMatchObject({ 'X-Tavily-Access-Mode': 'keyless' });
    expect(headers).not.toHaveProperty('Authorization');

    expect(body).toEqual({
      query: 'q',
      search_depth: 'basic',
      chunks_per_source: 3,
      max_results: 8,
    });
  });

  it('sends the active key instead of the keyless header', async () => {
    await addKey('tavily', 'tvly-key');
    network.mockResolvedValue(Response.json(answer));

    await tavily.search('q', signal());

    expect(request().headers).toMatchObject({ Authorization: 'Bearer tvly-key' });
    expect(request().headers).not.toHaveProperty('X-Tavily-Access-Mode');
  });

  it('fails on an unreadable answer', async () => {
    network.mockResolvedValue(Response.json({ nope: true }));

    await expect(tavily.search('q', signal())).rejects.toMatchObject({ code: 'request_failed' });
  });
});
