import 'fake-indexeddb/auto';

import { type ModelMessage, streamText } from 'ai';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { registerBuiltinProviders } from '../provider/builtin';
import type { CatalogModel, CatalogSlice } from '../provider/catalog-source';
import { updateProviderSetting } from '../provider/connection';
import { credentials } from '../provider/credentials';
import type { ProviderDefinition } from '../provider/definition';
import { listEndpointTest } from '../provider/key-test';
import { parseModelRef } from '../provider/ref';
import { resolveModel } from '../provider/resolve';
import { providers } from '../registry';
import { createRegistry } from '../registry/registry';
import { openDatabase } from '../storage/database';
import { installFakeChrome } from '../testing/fakeChrome';
import { defineTool, type ToolDefinition } from '../tool/tool';
import { cacheRoute, markRequest } from './cache';
import { createSessionEngine } from './engine';
import type { SessionLocks } from './queue';
import { buildRequest } from './request';
import type { AssistantMessage, AssistantTool, SessionMessage } from './schema';
import { createSessionStore } from './store';

const network = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.mock('../provider/fetch', () => ({ privateFetch: network }));

const SYSTEM = 'You are Sidekick.';
const SESSION = 'ses_1';
const FROGBOT = 'https://app.frogbot.ai/api/v1';
const PNG = 'data:image/png;base64,AAAA';
const EPHEMERAL = { type: 'ephemeral' };

const model = (id: string): CatalogModel => ({
  id,
  name: id,
  tool_call: true,
  limit: { context: 200_000, output: 32_000 },
});

const provider = (id: string, npm: string, ids: string[]) => ({
  id,
  name: id,
  npm,
  models: Object.fromEntries(ids.map((entry) => [entry, model(entry)])),
});

const CATALOG: CatalogSlice = {
  anthropic: provider('anthropic', '@ai-sdk/anthropic', ['claude-sonnet-4-5']),
  openai: provider('openai', '@ai-sdk/openai', ['gpt-5']),
  google: provider('google', '@ai-sdk/google', ['gemini-2.5-pro']),
  openrouter: provider('openrouter', '@openrouter/ai-sdk-provider', [
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5',
  ]),
};

const proxy: ProviderDefinition = {
  id: 'proxy',
  name: 'Proxy',
  route: '@ai-sdk/openai-compatible',
  baseURL: 'https://proxy.test/v1',
  auth: 'none',
  testKey: listEndpointTest({ path: '/models' }),
  listModels: () => Promise.resolve([{ id: 'claude-sonnet-4-5' }]),
};

type Chat = (body: Record<string, unknown>) => Response;

let chat: Chat = () => Response.json({ error: { message: 'stop here' } }, { status: 400 });
let disposers: (() => void)[] = [];

function serve() {
  network.mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url === `${FROGBOT}/models`) {
      return Promise.resolve(
        Response.json({
          data: ['claude-opus-5-5', 'gpt-5'].map((id) => ({ id, object: 'model', mode: 'chat' })),
        }),
      );
    }

    if (url === `${FROGBOT}/quota`) return Promise.resolve(Response.json({ balanceUSD: 5 }));

    const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};

    return Promise.resolve(chat(z.looseObject({}).catch({}).parse(body)));
  });
}

function lastBody(): Record<string, unknown> {
  const [, init] =
    network.mock.calls.findLast(([input]) => !String(input).endsWith('/quota')) ?? [];

  const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};

  return z.looseObject({}).parse(body);
}

const count = (value: unknown, word: string) => JSON.stringify(value).split(`"${word}"`).length - 1;

const connect = (providerID: string) =>
  credentials.add({
    providerID,
    label: providerID,
    value: { type: 'key', key: providerID === 'frogbot' ? 'fb_api_1' : `${providerID}-key` },
  });

async function resolve(ref: string) {
  const { providerID, modelID } = parseModelRef(ref);

  return {
    language: await resolveModel(ref, CATALOG),
    cache: cacheRoute(providers.get(providerID), { id: modelID }),
  };
}

async function send(ref: string, messages: readonly ModelMessage[]) {
  const { language, cache } = await resolve(ref);
  const marked = markRequest({ route: cache, system: SYSTEM, messages, sessionID: SESSION });

  await streamText({ model: language, ...marked, maxRetries: 0 }).consumeStream({
    onError: () => undefined,
  });

  return lastBody();
}

let seq = 0;

const user = (parts: Extract<SessionMessage, { type: 'user' }>['parts']): SessionMessage => ({
  id: `msg_${++seq}`,
  sessionID: SESSION,
  seq,
  type: 'user',
  time: { created: seq },
  parts,
});

function step(name: 'snapshot' | 'screenshot'): AssistantMessage {
  seq++;

  const call: AssistantTool = {
    type: 'tool',
    id: `call-${seq}`,
    name,
    time: { created: seq },
    state: {
      status: 'completed',
      input: { tab_id: 1 },
      output: { url: 'https://a.test/' },
      content:
        name === 'screenshot'
          ? [{ type: 'file', uri: PNG, mime: 'image/png' }]
          : [{ type: 'text', text: 'Page outline' }],
    },
  };

  return {
    id: `msg_${seq}`,
    sessionID: SESSION,
    seq,
    type: 'assistant',
    agent: 'build',
    model: 'x',
    time: { created: seq },
    content: [{ type: 'text', id: `t${seq}`, text: `Step ${seq}` }, call],
  };
}

const TAILS = {
  text: () => [user([{ type: 'text', text: 'Shop' }])],
  'tool-result': () => [user([{ type: 'text', text: 'Shop' }]), step('snapshot')],
  screenshot: () => [user([{ type: 'text', text: 'Shop' }]), step('screenshot')],
};

const request = (tail: keyof typeof TAILS) =>
  buildRequest({ messages: TAILS[tail](), reasoning: 'strip' });

beforeEach(async () => {
  installFakeChrome();
  globalThis.indexedDB = new IDBFactory();
  network.mockReset();
  chat = () => Response.json({ error: { message: 'stop here' } }, { status: 400 });
  serve();
  disposers = [registerBuiltinProviders(), providers.register('user', (draft) => draft.add(proxy))];

  for (const id of ['frogbot', 'anthropic', 'openai', 'google', 'openrouter']) await connect(id);

  await updateProviderSetting('proxy', { connected: true });
});

afterEach(() => {
  for (const dispose of disposers) dispose();
});

describe('Anthropic on the wire', () => {
  it.each([
    ['text', ['text']],
    ['tool-result', ['tool_result']],
    ['screenshot', ['tool_result', 'image']],
  ] as const)(
    'marks the system block and the last block of a %s tail, 3 markers at most and no ttl',
    async (tail, marked) => {
      const body = await send('anthropic/claude-sonnet-4-5', request(tail));
      const messages = z
        .array(z.object({ content: z.array(z.looseObject({})) }))
        .parse(body.messages);

      const blocks = messages.at(-1)?.content ?? [];

      expect(z.array(z.looseObject({})).parse(body.system)[0]?.cache_control).toEqual(EPHEMERAL);
      expect(blocks.at(-1)?.cache_control).toEqual(EPHEMERAL);

      expect(blocks.filter((block) => block.cache_control).map((block) => block.type)).toEqual(
        marked,
      );

      expect(count(body, 'cache_control')).toBe(marked.length + 1);
      expect(JSON.stringify(body)).not.toContain('ttl');
    },
  );
});

const Wire = z.array(
  z.looseObject({
    role: z.string(),
    content: z.union([z.string(), z.array(z.looseObject({}))]).nullish(),
  }),
);

describe('FrogBot and OpenRouter on the wire', () => {
  it('marks a Claude model’s system, last tool message and last image_url part', async () => {
    const messages = Wire.parse(
      (await send('frogbot/claude-opus-5-5', request('screenshot'))).messages,
    );

    const image = messages.at(-1);
    const parts = Array.isArray(image?.content) ? image.content : [];

    expect(messages[0]).toMatchObject({ role: 'system', cache_control: EPHEMERAL });
    expect(messages.at(-2)).toMatchObject({ role: 'tool', cache_control: EPHEMERAL });
    expect(parts.at(-1)).toMatchObject({ type: 'image_url', cache_control: EPHEMERAL });
    expect(count(messages, 'cache_control')).toBe(3);
  });

  it('marks string and array user content', async () => {
    const text = Wire.parse((await send('frogbot/claude-opus-5-5', request('text'))).messages);

    expect(text.at(-1)).toEqual({ role: 'user', content: 'Shop', cache_control: EPHEMERAL });

    const mixed = buildRequest({
      messages: [
        user([
          { type: 'text', text: 'What is this?' },
          { type: 'file', url: PNG, mediaType: 'image/png' },
        ]),
      ],
      reasoning: 'strip',
    });

    const array = Wire.parse((await send('frogbot/claude-opus-5-5', mixed)).messages);

    expect(array.at(-1)?.content).toEqual([
      { type: 'text', text: 'What is this?', cache_control: EPHEMERAL },
      { type: 'image_url', image_url: { url: PNG } },
    ]);
  });

  it('marks OpenRouter’s anthropic/ models', async () => {
    const body = await send('openrouter/anthropic/claude-sonnet-4.5', request('tool-result'));

    expect(count(body, 'cache_control')).toBe(2);

    expect(Wire.parse(body.messages).at(-1)).toMatchObject({
      role: 'tool',
      cache_control: EPHEMERAL,
    });
  });

  it.each([
    'frogbot/gpt-5',
    'proxy/claude-sonnet-4-5',
    'openrouter/openai/gpt-5',
    'google/gemini-2.5-pro',
  ])('sends %s no markers', async (ref) => {
    const body = await send(ref, request('screenshot'));

    expect(JSON.stringify(body)).not.toMatch(/cache_?control/i);
    expect(JSON.stringify(body)).not.toContain('prompt_cache_key');
  });
});

describe('OpenAI on the wire', () => {
  it('sends the session as prompt_cache_key, keeps store: false and sends no markers', async () => {
    const body = await send('openai/gpt-5', request('screenshot'));

    expect(body.prompt_cache_key).toBe(SESSION);
    expect(body.store).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/cache_?control/i);
  });
});

function memoryLocks(): SessionLocks {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run: (name, _ifAvailable, work) => {
      const next = (tails.get(name) ?? Promise.resolve()).then(work);

      tails.set(
        name,
        next.catch(() => undefined),
      );

      return next;
    },
  };
}

const echo = defineTool({
  id: 'echo',
  description: 'Echo text.',
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  permission: 'read',
  execute: ({ text }) => Promise.resolve({ output: { echoed: text } }),
});

const screenshot = defineTool({
  id: 'screenshot',
  description: 'Look at the page.',
  input: z.object({}),
  output: z.object({ url: z.string() }),
  permission: 'read',
  execute: () =>
    Promise.resolve({
      output: { url: 'https://a.test/' },
      content: [{ type: 'file', uri: PNG, mime: 'image/png' }],
    }),
});

const chunk = (body: object) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'claude-opus-5-5', ...body })}\n\n`;

const toolCall = (name: string, args: object, id: string) => [
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];

const reply = (content: string) => [
  { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
];

const ChatBody = z.looseObject({
  stream: z.boolean().optional(),
  tools: z.unknown(),
  messages: Wire,
});

const unmarked = (value: unknown) =>
  JSON.stringify(value, (key, inner: unknown) => (key === 'cache_control' ? undefined : inner));

function cachingServer(steps: object[][]) {
  const cache = new Map<string, number>();
  const sent: string[][] = [];

  chat = (raw) => {
    const body = ChatBody.parse(raw);

    if (!body.stream) return Response.json({ error: { message: 'no titles' } }, { status: 400 });

    const keys = body.messages.map(unmarked);
    const prefix = (length: number) => [unmarked(body.tools), ...keys.slice(0, length)].join('\n');
    const cached = Math.max(0, ...keys.map((_, index) => cache.get(prefix(index + 1)) ?? 0));

    body.messages.forEach((message, index) => {
      if (count(message, 'cache_control') > 0) {
        cache.set(prefix(index + 1), prefix(index + 1).length);
      }
    });

    const script = steps[sent.length] ?? reply('(script ended)');
    const total = prefix(keys.length).length;

    sent.push(keys);

    const usage = {
      prompt_tokens: total,
      completion_tokens: 1,
      total_tokens: total + 1,
      prompt_tokens_details: { cached_tokens: cached },
    };

    return new Response(
      [...script, { choices: [], usage }].map(chunk).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };

  return sent;
}

describe('cacheRead across one FrogBot turn', () => {
  it('grows on every step, through a screenshot step', async () => {
    const sent = cachingServer([
      toolCall('echo', { text: 'a' }, 'call-1'),
      toolCall('screenshot', {}, 'call-2'),
      toolCall('echo', { text: 'b' }, 'call-3'),
      reply('Done'),
    ]);

    const tools = createRegistry<ToolDefinition>('tools');
    const agents = createRegistry<AgentInfo>('agents');

    tools.register('test', (draft) => {
      for (const definition of [echo, screenshot]) draft.add(definition);
    });

    agents.register('test', (draft) => {
      for (const agent of BUILTIN_AGENTS) draft.add(agent);
    });

    const database = await openDatabase();

    const engine = createSessionEngine({
      store: createSessionStore(database),
      models: {
        resolve: async (ref) => {
          const { language, cache } = await resolve(ref);

          return { language, reasoning: 'strip', ...(cache ? { cache } : {}) };
        },
        list: () => Promise.resolve([]),
      },
      tools,
      agents,
      permission: { assert: () => Promise.resolve() },
      locks: memoryLocks(),
    });

    const session = await engine.create({ model: 'frogbot/claude-opus-5-5' });
    const prompt = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'Go' }],
    });

    await prompt.done;

    const reads = (await engine.messages(session.id)).flatMap((message) =>
      message.type === 'assistant' ? [message.tokens?.cacheRead ?? -1] : [],
    );

    database.close();

    expect(reads).toHaveLength(4);

    reads.slice(1).forEach((read, index) => expect(read).toBeGreaterThan(reads[index] ?? 0));

    sent.slice(1).forEach((keys, index) => {
      const previous = sent[index] ?? [];

      expect(keys.slice(0, previous.length)).toEqual(previous);
    });

    expect(JSON.parse(sent[2]?.at(-1) ?? '{}')).toMatchObject({ role: 'user' });
  });
});
