import { generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogSlice } from '../provider/catalog-source';
import { credentials } from '../provider/credentials';
import { availableModels } from '../provider/models';
import { resolveModel } from '../provider/resolve';
import { providers } from '../registry';
import { installFakeChrome } from '../testing/fakeChrome';
import { FrogbotError } from './client';
import { frogbotProvider } from './provider';
import { frogbotQuota } from './quota';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

const BASE = 'https://app.frogbot.ai/api/v1';

const CATALOG: CatalogSlice = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    models: {
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        tool_call: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        limit: { context: 1_000_000, output: 64_000 },
      },
    },
  },
};

const RICH = {
  object: 'list',
  data: [
    {
      id: 'claude-sonnet-5',
      object: 'model',
      created: 1,
      owned_by: 'firmware',
      name: 'Claude Sonnet 5',
      mode: 'chat',
      context_length: 1_000_000,
      max_output_tokens: 128_000,
      reasoning: true,
    },
    {
      id: 'text-embedding-3-small',
      object: 'model',
      name: 'Embedding',
      mode: 'embedding',
      context_length: 8191,
      max_output_tokens: null,
      reasoning: false,
    },
  ],
};

const chunk = (body: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'claude-sonnet-5', ...body })}\n\n`;

const SSE = [
  chunk({
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
  }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }),
  'data: [DONE]\n\n',
].join('');

type Answer = (url: string, init?: RequestInit) => Response | undefined;

let chat: Answer = () => undefined;
let models: unknown = RICH;
let balance = 4.5;

function serve() {
  network.mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url === `${BASE}/models`) return Promise.resolve(Response.json(models));

    if (url === `${BASE}/quota`) return Promise.resolve(Response.json({ balanceUSD: balance }));

    return Promise.resolve(
      chat(url, init) ?? new Response(SSE, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
  });
}

function calls() {
  return network.mock.calls.map(([input, init]) => ({
    url: String(input instanceof Request ? input.url : input),
    init,
    headers: new Headers(init?.headers),
  }));
}

let key = 0;
let disposers: (() => void)[] = [];

beforeEach(async () => {
  installFakeChrome();
  network.mockReset();
  chat = () => undefined;
  models = RICH;
  balance = 4.5;
  serve();
  disposers = [providers.register('builtin', (draft) => draft.add(frogbotProvider))];
  key++;

  await credentials.add({
    providerID: 'frogbot',
    label: 'Sidekick',
    value: { type: 'key', key: `fb_api_${key}` },
  });
});

afterEach(() => {
  for (const dispose of disposers) dispose();
});

describe('FrogBot chat', () => {
  it('streams from /api/v1/chat/completions with the key, the source header and no cookies', async () => {
    const result = streamText({
      model: await resolveModel('frogbot/claude-sonnet-5', CATALOG),
      prompt: 'hi',
    });

    expect(await result.text).toBe('Hi');

    const request = calls().find(({ url }) => url.endsWith('/chat/completions'));

    expect(request?.url).toBe(`${BASE}/chat/completions`);
    expect(request?.headers.get('authorization')).toBe(`Bearer fb_api_${key}`);
    expect(request?.headers.get('x-frogbot-source')).toBe('sidekick');
    expect(request?.init?.credentials).toBe('omit');

    expect(JSON.parse(String(request?.init?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });

    expect(calls().some(({ url }) => url.includes('/v1/messages'))).toBe(false);
    expect(calls().every(({ init }) => init?.credentials === 'omit')).toBe(true);
  });

  it('reads the streamed usage chunk, then refreshes the balance', async () => {
    balance = 3.25;

    const result = streamText({
      model: await resolveModel('frogbot/claude-sonnet-5', CATALOG),
      prompt: 'hi',
    });

    expect((await result.totalUsage).inputTokens).toBe(11);
    expect((await result.totalUsage).outputTokens).toBe(3);

    await vi.waitFor(async () => expect((await frogbotQuota.get())?.balanceUSD).toBe(3.25));
  });

  it.each([
    [401, {}, { code: 'reconnect' }],
    [402, {}, { code: 'credit', balanceUSD: 0 }],
    [429, { 'Retry-After': '30' }, { code: 'rate-limited', retryAfterSeconds: 30 }],
  ])('turns a %i from the chat route into a FrogbotError', async (status, headers, expected) => {
    balance = 0;
    chat = () => Response.json({ error: 'refused' }, { status, headers });

    const error = await generateText({
      model: await resolveModel('frogbot/claude-sonnet-5', CATALOG),
      prompt: 'hi',
      maxRetries: 0,
    }).catch((caught: unknown) => caught);

    expect(FrogbotError.is(error)).toBe(true);
    expect(error).toMatchObject(expected);
  });

  it('lets AI SDK retry a 429 after Retry-After', async () => {
    let refused = false;

    chat = () => {
      if (refused) return undefined;

      refused = true;

      return Response.json(
        { error: 'slow down' },
        { status: 429, headers: { 'Retry-After': '0' } },
      );
    };

    const result = streamText({
      model: await resolveModel('frogbot/claude-sonnet-5', CATALOG),
      prompt: 'hi',
      maxRetries: 1,
    });

    expect(await result.text).toBe('Hi');
    expect(calls().filter(({ url }) => url.endsWith('/chat/completions'))).toHaveLength(2);
  });
});

describe('FrogBot models', () => {
  it('keeps only chat models from a rich list, with name, limits and reasoning', async () => {
    expect(await availableModels({ catalog: CATALOG, discover: true })).toEqual([
      expect.objectContaining({
        providerID: 'frogbot',
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        route: '@ai-sdk/openai-compatible',
        limit: { context: 1_000_000, output: 128_000 },
        reasoning: true,
      }),
    ]);
  });

  it('joins an id-only list to models.dev by id, hiding ids with no chat entry', async () => {
    models = { data: [{ id: 'claude-sonnet-5' }, { id: 'text-embedding-3-small' }] };

    expect(await availableModels({ catalog: CATALOG, discover: true })).toEqual([
      expect.objectContaining({
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        limit: { context: 1_000_000, output: 64_000 },
        reasoning: true,
      }),
    ]);
  });

  it('lists nothing while disconnected', async () => {
    installFakeChrome();

    expect(await availableModels({ catalog: CATALOG, discover: true })).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
});
