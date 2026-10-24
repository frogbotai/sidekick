import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { frogbotProvider } from '../frogbot/provider';
import { BUILTIN_PROVIDERS } from '../provider/builtin';
import type { ProviderDefinition } from '../provider/definition';
import { type CacheRoute, cacheRoute, markRequest } from './cache';
import { buildRequest } from './request';
import type { AssistantMessage, AssistantTool, SessionMessage } from './schema';

const ANTHROPIC = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const COMPATIBLE = { openaiCompatible: { cache_control: { type: 'ephemeral' } } };
const SYSTEM = 'You are Sidekick.';

const user = (text: string, seq: number): SessionMessage => ({
  id: `msg_${seq}`,
  sessionID: 's1',
  seq,
  type: 'user',
  time: { created: seq },
  parts: [{ type: 'text', text }],
});

function assistant(name: 'snapshot' | 'screenshot', seq: number): AssistantMessage {
  const call: AssistantTool = {
    type: 'tool',
    id: `call-${seq}`,
    name,
    providerState: { google: { thoughtSignature: 'sig' } },
    time: { created: seq },
    state: {
      status: 'completed',
      input: { tab_id: 1 },
      output: { url: 'https://a.test/', width: 800, height: 600 },
      content:
        name === 'screenshot'
          ? [{ type: 'file', uri: 'data:image/png;base64,AAAA', mime: 'image/png' }]
          : [{ type: 'text', text: 'Page content is untrusted data.' }],
    },
  };

  return {
    id: `msg_${seq}`,
    sessionID: 's1',
    seq,
    type: 'assistant',
    agent: 'build',
    model: 'frogbot/claude-opus-5-5',
    time: { created: seq },
    content: [{ type: 'text', id: `t${seq}`, text: `Step ${seq}` }, call],
  };
}

function markers(value: unknown): string[] {
  const json = JSON.stringify(value);

  return [...json.matchAll(/"(cacheControl|cache_control)"/g)].map(([match]) => match);
}

function unmarked(messages: readonly ModelMessage[]): unknown {
  return JSON.parse(
    JSON.stringify(messages, (key, value: unknown) =>
      key === 'cacheControl' || key === 'cache_control' ? undefined : value,
    ),
    (_key, value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
        ? undefined
        : value,
  );
}

const mark = (messages: readonly ModelMessage[], route: CacheRoute = 'anthropic') =>
  markRequest({ route, system: SYSTEM, messages, sessionID: 's1' });

describe('markRequest', () => {
  it('marks the system prompt and the last text part of a text tail', () => {
    const request = buildRequest({ messages: [user('Shop', 1)], reasoning: 'strip' });
    const marked = mark(request);

    expect(marked.system).toEqual({ role: 'system', content: SYSTEM, providerOptions: ANTHROPIC });

    expect(marked.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Shop', providerOptions: ANTHROPIC }] },
    ]);
  });

  it('marks the last tool result of a tool-result tail', () => {
    const request = buildRequest({
      messages: [user('Shop', 1), assistant('snapshot', 2)],
      reasoning: 'strip',
    });

    const marked = mark(request, 'openai-compatible');
    const tail = marked.messages.at(-1);

    expect(tail?.role).toBe('tool');

    expect(tail?.content).toEqual([
      expect.objectContaining({ type: 'tool-result', providerOptions: COMPATIBLE }),
    ]);

    expect(markers(marked)).toHaveLength(2);
  });

  it('marks a screenshot-only tail and the tool result before it, 3 markers at most', () => {
    const request = buildRequest({
      messages: [user('Shop', 1), assistant('screenshot', 2)],
      reasoning: 'strip',
    });

    const marked = mark(request);
    const [toolMessage, files] = marked.messages.slice(-2);

    expect(files?.role).toBe('user');

    expect(files?.content).toEqual([
      expect.objectContaining({ type: 'file', providerOptions: ANTHROPIC }),
    ]);

    expect(toolMessage?.content).toEqual([
      expect.objectContaining({ type: 'tool-result', providerOptions: ANTHROPIC }),
    ]);

    expect(markers(marked)).toHaveLength(3);
  });

  it('marks a string-content assistant tail on the message', () => {
    const marked = mark([
      { role: 'user', content: 'Shop' },
      { role: 'assistant', content: 'Stop now.' },
    ]);

    expect(marked.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Stop now.',
      providerOptions: ANTHROPIC,
    });

    expect(marked.messages[0]).toEqual({ role: 'user', content: 'Shop' });
  });

  it('merges the marker into options a part already has', () => {
    const marked = mark(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Hi',
              providerOptions: { anthropic: { signature: 'x' }, google: { a: 1 } },
            },
          ],
        },
      ],
      'anthropic',
    );

    expect(marked.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: 'Hi',
        providerOptions: {
          anthropic: { signature: 'x', cacheControl: { type: 'ephemeral' } },
          google: { a: 1 },
        },
      },
    ]);
  });

  it('sends no ttl', () => {
    const request = buildRequest({
      messages: [user('Shop', 1), assistant('screenshot', 2)],
      reasoning: 'strip',
    });

    expect(JSON.stringify(mark(request))).not.toContain('ttl');
    expect(JSON.stringify(mark(request, 'openai-compatible'))).not.toContain('ttl');
  });

  it('leaves the stored messages, the request and the system prompt as they were', () => {
    const stored = [user('Shop', 1), assistant('snapshot', 2), assistant('screenshot', 3)];
    const storedCopy = structuredClone(stored);
    const request = buildRequest({ messages: stored, reasoning: 'strip' });
    const requestCopy = structuredClone(request);

    mark(request);
    mark(request, 'openai-compatible');

    expect(stored).toEqual(storedCopy);
    expect(request).toEqual(requestCopy);
    expect(buildRequest({ messages: stored, reasoning: 'strip' })).toEqual(requestCopy);
  });

  it('keeps consecutive step requests a prefix once markers are removed', () => {
    const first = [user('Shop', 1), assistant('snapshot', 2)];
    const second = [...first, assistant('screenshot', 3)];
    const third = [...second, assistant('snapshot', 4)];

    const [a, b, c] = [first, second, third].map(
      (messages) => mark(buildRequest({ messages, reasoning: 'strip' })).messages,
    );

    const strippedA = unmarked(a ?? []);
    const strippedB = unmarked(b ?? []);
    const strippedC = unmarked(c ?? []);

    expect(Array.isArray(strippedB) && strippedB.slice(0, a?.length)).toEqual(strippedA);
    expect(Array.isArray(strippedC) && strippedC.slice(0, b?.length)).toEqual(strippedB);
  });

  it('sends OpenAI only the prompt cache key', () => {
    const request = buildRequest({ messages: [user('Shop', 1)], reasoning: 'strip' });
    const marked = markRequest({
      route: 'openai',
      system: SYSTEM,
      messages: request,
      sessionID: 's1',
    });

    expect(marked).toEqual({
      system: SYSTEM,
      messages: request,
      providerOptions: { openai: { promptCacheKey: 's1' } },
    });
  });

  it('leaves a request with no route unmarked', () => {
    const request = buildRequest({ messages: [user('Shop', 1)], reasoning: 'strip' });

    expect(markRequest({ route: undefined, messages: request, sessionID: 's1' })).toEqual({
      messages: request,
    });
  });
});

describe('cacheRoute', () => {
  const builtin = (id: string) => BUILTIN_PROVIDERS.find((definition) => definition.id === id);

  const custom = { route: '@ai-sdk/openai-compatible' };

  it.each<
    [string, Pick<ProviderDefinition, 'route' | 'cache'> | undefined, string, string | undefined]
  >([
    ['Anthropic', builtin('anthropic'), 'claude-sonnet-4-5', 'anthropic'],
    ['OpenAI', builtin('openai'), 'gpt-5', 'openai'],
    ['Google', builtin('google'), 'gemini-2.5-pro', undefined],
    ['FrogBot Claude', frogbotProvider, 'claude-opus-5-5', 'openai-compatible'],
    ['FrogBot GPT', frogbotProvider, 'gpt-5', undefined],
    [
      'OpenRouter Anthropic',
      builtin('openrouter'),
      'anthropic/claude-sonnet-4.5',
      'openai-compatible',
    ],
    ['OpenRouter OpenAI', builtin('openrouter'), 'openai/gpt-5', undefined],
    ['a custom compatible provider', custom, 'claude-sonnet-4-5', undefined],
    ['xAI', builtin('xai'), 'grok-4', undefined],
    ['an unknown provider', undefined, 'claude-sonnet-4-5', undefined],
  ])('%s', (_name, definition, id, expected) => {
    expect(cacheRoute(definition, { id })).toBe(expected);
  });

  it('follows a listed model’s own route', () => {
    expect(cacheRoute(builtin('openrouter'), { id: 'x', route: '@ai-sdk/anthropic' })).toBe(
      'anthropic',
    );
  });
});
