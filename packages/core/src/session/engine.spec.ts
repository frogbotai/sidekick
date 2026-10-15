import 'fake-indexeddb/auto';

import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { createRegistry } from '../registry/registry';
import { openDatabase } from '../storage/database';
import { defineTool, type ToolDefinition } from '../tool/tool';
import { createSessionEngine, MAX_STEPS_PROMPT, type SessionLocks } from './engine';
import { CHAT_FULL } from './retry';
import type { AssistantMessage, SessionMessage } from './schema';
import { createSessionStore, type SessionStore } from './store';

type Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];

type LanguageModelV4StreamPart = Stream extends ReadableStream<infer Part> ? Part : never;

type LanguageModelV4CallOptions = MockLanguageModelV4['doStreamCalls'][number];

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

type Script = LanguageModelV4StreamPart[] | Error | (() => Promise<LanguageModelV4StreamPart[]>);

const finish = (unified: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage: USAGE,
});

const text = (value: string, id = 't'): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
  finish(),
];

const call = (
  toolName: string,
  input: object,
  toolCallId = 'call-1',
): LanguageModelV4StreamPart[] => [
  { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
  finish('tool-calls'),
];

function scripted(steps: Script[]) {
  const queue = [...steps];

  return new MockLanguageModelV4({
    doStream: async () => {
      const next = queue.shift() ?? text('(script ended)');

      if (next instanceof Error) throw next;

      const parts = typeof next === 'function' ? await next() : next;

      return { stream: convertArrayToReadableStream(parts) };
    },
    doGenerate: () => Promise.reject(new Error('No title model')),
  });
}

function memoryLocks(): SessionLocks & { held: Set<string> } {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();

  return {
    held,
    run: (name, ifAvailable, work) => {
      if (ifAvailable && held.has(name)) return Promise.resolve(undefined);

      const previous = tails.get(name) ?? Promise.resolve();

      const next = previous.then(async () => {
        held.add(name);

        try {
          return await work();
        } finally {
          held.delete(name);
        }
      });

      tails.set(
        name,
        next.catch(() => undefined),
      );

      return next;
    },
  };
}

function fakeClock() {
  let now = 1_000;
  const sleeps: number[] = [];

  return {
    sleeps,
    clock: {
      now: () => now++,
      random: () => 0.5,
      sleep: (ms: number) => {
        sleeps.push(ms);
        now += ms;

        return Promise.resolve();
      },
    },
  };
}

function gate() {
  let open = () => {};

  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { open, opened };
}

const echo = defineTool({
  id: 'echo',
  description: 'Echo text.',
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  permission: 'read',
  execute: async ({ text: value }, ctx) => {
    await ctx.permission.assert({ action: 'read', resource: 'https://a.test' });

    return { output: { echoed: value } };
  },
});

const hang = defineTool({
  id: 'hang',
  description: 'Never ends.',
  input: z.object({}),
  output: z.object({}),
  permission: 'read',
  execute: (_, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
});

const opened: IDBDatabase[] = [];

interface Setup {
  steps?: Script[];
  agents?: AgentInfo[];
  title?: MockLanguageModelV4;
  store?: SessionStore;
  locks?: SessionLocks;
}

async function setup({ steps = [], agents = [...BUILTIN_AGENTS], title, ...rest }: Setup = {}) {
  let store = rest.store;

  if (!store) {
    const database = await openDatabase();

    opened.push(database);
    store = createSessionStore(database);
  }

  const model = scripted(steps);
  const toolRegistry = createRegistry<ToolDefinition>('tools');
  const agentRegistry = createRegistry<AgentInfo>('agents');
  const { clock, sleeps } = fakeClock();
  const resolved: string[] = [];
  const asserts: string[] = [];
  const idle: string[] = [];

  toolRegistry.register('test', (draft) => {
    for (const definition of [echo, hang]) draft.add(definition);
  });

  agentRegistry.register('test', (draft) => {
    for (const agent of agents) draft.add(agent);
  });

  const engine = createSessionEngine({
    store,
    models: {
      resolve: (ref) => {
        resolved.push(ref);

        return Promise.resolve({
          language: title && ref.includes('haiku') ? title : model,
          reasoning: 'strip',
        });
      },
      list: () =>
        Promise.resolve([
          {
            providerID: 'anthropic',
            id: 'claude-haiku-4-5',
            name: 'Haiku',
            route: '@ai-sdk/anthropic',
            family: 'claude-haiku',
            variants: [],
          },
        ]),
    },
    tools: toolRegistry,
    agents: agentRegistry,
    permission: {
      assert: (request, scope) => {
        asserts.push(`${scope.agent}:${request.action}`);

        return Promise.resolve();
      },
    },
    clock,
    locks: rest.locks ?? memoryLocks(),
    onIdle: (sessionID) => idle.push(sessionID),
  });

  const session = await engine.create({ model: 'anthropic/claude-sonnet-4-5' });

  return { store, engine, model, session, sleeps, resolved, asserts, idle };
}

async function send(
  engine: Awaited<ReturnType<typeof setup>>['engine'],
  sessionID: string,
  value: string,
) {
  const sent = await engine.prompt({ sessionID, parts: [{ type: 'text', text: value }] });

  await sent.done;

  return sent;
}

const kinds = (messages: SessionMessage[]) =>
  messages.map((message) => (message.type === 'idle' ? `idle:${message.outcome}` : message.type));

const assistants = (messages: SessionMessage[]) =>
  messages.filter((message): message is AssistantMessage => message.type === 'assistant');

function promptOf(options: LanguageModelV4CallOptions | undefined) {
  return JSON.stringify(options?.prompt ?? []);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe('the loop', () => {
  it('runs a tool call, sends its result back, then ends on text', async () => {
    const { engine, model, session, asserts, idle } = await setup({
      steps: [call('echo', { text: 'hi' }), text('All done')],
    });

    await send(engine, session.id, 'Echo hi');

    const messages = await engine.messages(session.id);

    expect(kinds(messages)).toEqual(['user', 'assistant', 'assistant', 'idle:succeeded']);

    expect(assistants(messages)[0]?.content).toMatchObject([
      { type: 'tool', id: 'call-1', state: { status: 'completed', output: { echoed: 'hi' } } },
    ]);

    expect(assistants(messages)[1]?.content).toMatchObject([{ type: 'text', text: 'All done' }]);
    expect(promptOf(model.doStreamCalls[1])).toContain('"echoed":"hi"');
    expect(asserts).toEqual(['build:read']);
    expect(idle).toEqual([session.id]);
  });

  it('gives the last allowed step v2’s max-steps prompt and toolChoice none', async () => {
    const capped = BUILTIN_AGENTS.map((agent) =>
      agent.id === 'build' ? { ...agent, steps: 2 } : agent,
    );

    const { engine, model, session } = await setup({
      agents: capped,
      steps: [call('echo', { text: 'a' }), text('Out of steps')],
    });

    await send(engine, session.id, 'Go');

    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' });
    expect(model.doStreamCalls[1]?.toolChoice).toEqual({ type: 'none' });
    expect(model.doStreamCalls[1]?.tools?.map((tool) => tool.name)).toEqual(['echo', 'hang']);
    expect(promptOf(model.doStreamCalls[1])).toContain('MAXIMUM STEPS REACHED');
    expect(model.doStreamCalls[1]?.prompt.at(-1)).toMatchObject({ role: 'assistant' });
    expect(MAX_STEPS_PROMPT).toContain('Respond with text ONLY.');
  });

  it('retries a 429 after its retry-after, in the same message', async () => {
    const limited = new APICallError({
      message: 'Rate limited',
      url: 'https://api.test',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after': '30' },
    });

    const { engine, session, sleeps } = await setup({ steps: [limited, text('Back')] });

    await send(engine, session.id, 'Hi');

    const messages = await engine.messages(session.id);

    expect(sleeps).toEqual([30_000]);
    expect(kinds(messages)).toEqual(['user', 'assistant', 'idle:succeeded']);
    expect(assistants(messages)[0]).not.toHaveProperty('retry');
    expect(assistants(messages)[0]).not.toHaveProperty('error');
  });

  it('ends an overflow with "This chat is full"', async () => {
    const overflow = new APICallError({
      message: 'prompt is too long: 250000 tokens > 200000 maximum',
      url: 'https://api.test',
      requestBodyValues: {},
      statusCode: 400,
    });

    const { engine, session, sleeps } = await setup({ steps: [overflow] });

    await send(engine, session.id, 'Hi');

    const messages = await engine.messages(session.id);

    expect(sleeps).toEqual([]);
    expect(kinds(messages)).toEqual(['user', 'assistant', 'idle:failed']);
    expect(assistants(messages)[0]?.error).toEqual({ type: 'overflow', message: CHAT_FULL });
    expect(CHAT_FULL).toBe('This chat is full. Start a new one.');
  });

  it('writes model-switched before the next turn, which uses the new model', async () => {
    const { engine, session, resolved } = await setup({ steps: [text('Hi')] });

    await (
      await engine.prompt({
        sessionID: session.id,
        parts: [{ type: 'text', text: 'Hello' }],
        model: 'openai/gpt-5',
      })
    ).done;

    const messages = await engine.messages(session.id);

    expect(kinds(messages)).toEqual(['model-switched', 'user', 'assistant', 'idle:succeeded']);

    expect(messages[0]).toMatchObject({
      model: 'openai/gpt-5',
      previous: 'anthropic/claude-sonnet-4-5',
    });

    expect(assistants(messages)[0]?.model).toBe('openai/gpt-5');
    expect(resolved).toContain('openai/gpt-5');
  });
});

describe('turns', () => {
  it('queues a prompt sent during a turn and runs it next', async () => {
    const hold = gate();

    const { engine, session } = await setup({
      steps: [
        async () => {
          await hold.opened;

          return text('First');
        },
        text('Second'),
      ],
    });

    const first = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'One' }],
    });

    await expect.poll(() => engine.busy(session.id)).toBe(true);

    const second = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'Two' }],
    });

    expect(engine.queued(session.id)).toEqual([
      { messageID: second.messageID, parts: [{ type: 'text', text: 'Two' }] },
    ]);

    hold.open();
    await Promise.all([first.done, second.done]);

    const messages = await engine.messages(session.id);

    expect(kinds(messages)).toEqual([
      'user',
      'assistant',
      'idle:succeeded',
      'user',
      'assistant',
      'idle:succeeded',
    ]);

    expect(engine.queued(session.id)).toEqual([]);
  });

  it('truncates from an edited message before the next turn', async () => {
    const { engine, session } = await setup({ steps: [text('First'), text('Edited')] });
    const { messageID } = await send(engine, session.id, 'Original');

    await (
      await engine.prompt({
        sessionID: session.id,
        parts: [{ type: 'text', text: 'Changed' }],
        from: messageID,
      })
    ).done;

    const messages = await engine.messages(session.id);

    expect(kinds(messages)).toEqual(['user', 'assistant', 'idle:succeeded']);
    expect(messages[0]).toMatchObject({ parts: [{ text: 'Changed' }] });
    expect(assistants(messages)[0]?.content).toMatchObject([{ text: 'Edited' }]);
  });

  it('marks a running tool interrupted on abort and ends the turn interrupted', async () => {
    const { engine, session } = await setup({ steps: [call('hang', {})] });
    const sent = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'Wait' }],
    });

    await expect
      .poll(async () => JSON.stringify(await engine.messages(session.id)))
      .toContain('"status":"running"');

    engine.abort(session.id);
    await sent.done;

    const messages = await engine.messages(session.id);

    expect(kinds(messages)).toEqual(['user', 'assistant', 'idle:interrupted']);

    expect(assistants(messages)[0]).toMatchObject({
      content: [{ state: { status: 'error', error: { message: 'Tool execution interrupted' } } }],
      error: { type: 'aborted' },
    });
  });

  it('sweeps tools a closed panel left running, skipping a session another window holds', async () => {
    const locks = memoryLocks();
    const { engine, store, session } = await setup({ locks });
    const busy = await engine.create({ model: 'openai/gpt-5' });

    for (const sessionID of [session.id, busy.id]) {
      await store.publish(sessionID, {
        type: 'session.prompted',
        messageID: `u-${sessionID}`,
        parts: [],
      });

      await store.publish(sessionID, {
        type: 'session.step.started',
        messageID: `a-${sessionID}`,
        agent: 'build',
        model: 'openai/gpt-5',
      });

      await store.publish(sessionID, {
        type: 'session.tool.called',
        messageID: `a-${sessionID}`,
        callID: 'c1',
        name: 'echo',
        input: { text: 'x' },
      });
    }

    const hold = gate();
    const holding = locks.run(`sidekick.session.${busy.id}`, false, () => hold.opened);

    await expect.poll(() => locks.held.size).toBe(1);

    await engine.sweep();

    const swept = await engine.messages(session.id);

    expect(kinds(swept)).toEqual(['user', 'assistant', 'idle:interrupted']);

    expect(assistants(swept)[0]?.content).toMatchObject([
      { state: { status: 'error', error: { message: 'Tool execution interrupted' } } },
    ]);

    expect(kinds(await engine.messages(busy.id))).toEqual(['user', 'assistant']);

    hold.open();
    await holding;
  });

  it('never overlaps two engines’ turns on one session', async () => {
    const locks = memoryLocks();
    let active = 0;
    let most = 0;

    const slow = () => async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;

      return text('ok');
    };

    const one = await setup({ locks, steps: [slow(), slow()] });
    const two = await setup({ locks, store: one.store, steps: [slow(), slow()] });

    const sent = await Promise.all([
      one.engine.prompt({ sessionID: one.session.id, parts: [{ type: 'text', text: 'a' }] }),
      two.engine.prompt({ sessionID: one.session.id, parts: [{ type: 'text', text: 'b' }] }),
      one.engine.prompt({ sessionID: one.session.id, parts: [{ type: 'text', text: 'c' }] }),
    ]);

    await Promise.all(sent.map(({ done }) => done));

    expect(most).toBe(1);

    expect(kinds(await one.store.messages(one.session.id))).toEqual(
      Array.from({ length: 3 }, () => ['user', 'assistant', 'idle:succeeded']).flat(),
    );
  });
});

describe('deletes and abandoned turns', () => {
  it('deletes a chat during a running tool, ending the turn and leaving nothing', async () => {
    const { engine, session, store, idle } = await setup({ steps: [call('hang', {})] });
    const sent = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'x' }],
    });

    await expect
      .poll(async () => JSON.stringify(await engine.messages(session.id)))
      .toContain('"status":"running"');

    await engine.sessions.delete(session.id);
    await sent.done;

    expect(await store.sessions.get(session.id)).toBeUndefined();
    expect(await store.messages(session.id)).toEqual([]);
    expect(idle).toEqual([session.id]);
  });

  it('never calls the model for a chat deleted right after its prompt', async () => {
    const { engine, session, model } = await setup({ steps: [text('a')] });
    const sent = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'x' }],
    });

    await engine.sessions.delete(session.id);
    await sent.done;

    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('deletes at once while another window’s turn runs, and that turn still goes idle', async () => {
    const locks = memoryLocks();
    const one = await setup({ locks, steps: [call('hang', {})] });
    const two = await setup({ locks, store: one.store });
    const sent = await one.engine.prompt({
      sessionID: one.session.id,
      parts: [{ type: 'text', text: 'x' }],
    });

    await expect
      .poll(async () => JSON.stringify(await one.engine.messages(one.session.id)))
      .toContain('"status":"running"');

    await two.engine.sessions.delete(one.session.id);

    expect(await one.store.sessions.get(one.session.id)).toBeUndefined();

    one.engine.abort(one.session.id);
    await sent.done;

    expect(await one.store.messages(one.session.id)).toEqual([]);
    expect(one.idle).toEqual([one.session.id]);
  });

  it('settles a turn a closed window abandoned before the next prompt runs', async () => {
    const { engine, store, session } = await setup({ steps: [text('ok')] });

    await store.publish(session.id, { type: 'session.prompted', messageID: 'u-1', parts: [] });

    await store.publish(session.id, {
      type: 'session.step.started',
      messageID: 'a-1',
      agent: 'build',
      model: 'openai/gpt-5',
    });

    await store.publish(session.id, {
      type: 'session.tool.called',
      messageID: 'a-1',
      callID: 'c1',
      name: 'echo',
      input: { text: 'x' },
    });

    await send(engine, session.id, 'Again');

    const messages = await engine.messages(session.id);

    expect(kinds(messages)).toEqual([
      'user',
      'assistant',
      'idle:interrupted',
      'user',
      'assistant',
      'idle:succeeded',
    ]);

    expect(assistants(messages)[0]?.content).toMatchObject([
      { state: { status: 'error', error: { message: 'Tool execution interrupted' } } },
    ]);
  });
});

describe('titles', () => {
  const titleModel = (reply: string | Error) =>
    new MockLanguageModelV4({
      doGenerate: () =>
        reply instanceof Error
          ? Promise.reject(reply)
          : Promise.resolve({
              content: [{ type: 'text', text: `${reply}\nignored` }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: USAGE,
              warnings: [],
            }),
    });

  it('titles an untitled root once, on the small model, from the first message', async () => {
    const title = titleModel('Flight search');
    const { engine, session, store } = await setup({ title, steps: [text('a'), text('b')] });

    await send(engine, session.id, 'Find flights to Lisbon');

    await expect
      .poll(async () => (await store.sessions.get(session.id))?.title)
      .toBe('Flight search');

    await send(engine, session.id, 'Cheaper ones');

    expect(title.doGenerateCalls).toHaveLength(1);
    expect(JSON.stringify(title.doGenerateCalls[0]?.prompt)).toContain('Find flights to Lisbon');

    expect(JSON.stringify(title.doGenerateCalls[0]?.prompt)).toContain(
      'You are a title generator.',
    );
  });

  it('leaves child sessions and titled sessions alone', async () => {
    const title = titleModel('Never');
    const { engine, session, store } = await setup({ title, steps: [text('a'), text('b')] });
    const child = await engine.create({ model: session.model, parentID: session.id });

    await store.sessions.rename(session.id, 'Mine');
    await send(engine, session.id, 'Hi');
    await send(engine, child.id, 'Hi');

    expect(title.doGenerateCalls).toHaveLength(0);
    expect((await store.sessions.get(session.id))?.title).toBe('Mine');
  });

  it('leaves the session untitled when the title call fails', async () => {
    const title = titleModel(new Error('down'));
    const { engine, session, store } = await setup({ title, steps: [text('a')] });

    await send(engine, session.id, 'Hi');

    await expect.poll(() => title.doGenerateCalls.length).toBe(1);

    expect((await store.sessions.get(session.id))?.title).toBeUndefined();
  });
});
