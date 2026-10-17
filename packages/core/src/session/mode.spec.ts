import 'fake-indexeddb/auto';

import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import type { PermissionScope } from '../permission/engine';
import { BUILTIN_MODES, type PermissionMode, PLAN_ENTER, PLAN_LEAVE } from '../permission/modes';
import { createRegistry } from '../registry/registry';
import { openDatabase } from '../storage/database';
import { defineTool, type PermissionRequest, type ToolDefinition, ToolError } from '../tool/tool';
import { createSessionEngine } from './engine';
import type { SessionLocks } from './queue';
import type { AssistantMessage, SessionMessage } from './schema';
import { TOOL_DECLINED } from './step';
import { createSessionStore } from './store';
import { toUIMessages } from './ui';

type Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];

type Part = Stream extends ReadableStream<infer P> ? P : never;

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const finish = (unified: 'stop' | 'tool-calls' = 'stop'): Part => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage: USAGE,
});

const text = (value: string): Part[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: value },
  { type: 'text-end', id: 't' },
  finish(),
];

const calls = (...entries: [string, string][]): Part[] => [
  ...entries.map(([toolName, toolCallId]): Part => ({
    type: 'tool-call',
    toolCallId,
    toolName,
    input: '{}',
  })),
  finish('tool-calls'),
];

const locks: SessionLocks = { run: (_name, _ifAvailable, work) => work() };

function tool(id: string, permission: PermissionRequest['action']): ToolDefinition {
  return defineTool({
    id,
    description: id,
    input: z.object({}),
    output: z.object({}),
    permission,
    execute: async (_input, ctx) => {
      await ctx.permission.assert({ action: permission, resource: 'https://github.com' });

      if (id === 'wait') {
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }

      return { output: {} };
    },
  });
}

const opened: IDBDatabase[] = [];

async function setup(steps: Part[][], verdicts: Record<string, ToolError> = {}) {
  const database = await openDatabase();

  opened.push(database);

  const queue = [...steps];

  const model = new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({ stream: convertArrayToReadableStream(queue.shift() ?? text('end')) }),
    doGenerate: () => Promise.reject(new Error('No title model')),
  });

  const tools = createRegistry<ToolDefinition>('tools');
  const agents = createRegistry<AgentInfo>('agents');
  const modes = createRegistry<PermissionMode>('permissionModes');
  const scopes: PermissionScope[] = [];

  tools.register('test', (draft) => {
    for (const entry of [tool('look', 'read'), tool('poke', 'input'), tool('wait', 'read')]) {
      draft.add(entry);
    }
  });

  agents.register('test', (draft) => {
    for (const agent of BUILTIN_AGENTS) draft.add(agent);
  });

  modes.register('test', (draft) => {
    for (const mode of BUILTIN_MODES) draft.add(mode);
  });

  let count = 0;

  const engine = createSessionEngine({
    store: createSessionStore(database),
    models: {
      resolve: () => Promise.resolve({ language: model, reasoning: 'strip' }),
      list: () => Promise.resolve([]),
    },
    tools,
    agents,
    modes,
    permission: {
      assert: (_request, scope) => {
        scopes.push(scope);

        const verdict = verdicts[scope.callID];

        return verdict ? Promise.reject(verdict) : Promise.resolve();
      },
    },
    clock: {
      now: () => 1_000 + count++,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
    },
    locks,
  });

  const send = async (sessionID: string, input: { mode?: string; site?: string } = {}) => {
    const sent = await engine.prompt({
      sessionID,
      parts: [{ type: 'text', text: 'Go' }],
      ...input,
    });

    await sent.done;
  };

  return { engine, model, scopes, send };
}

const synthetic = (messages: SessionMessage[]) =>
  messages.flatMap((message) => (message.type === 'synthetic' ? [message.text] : []));

const offered = (model: MockLanguageModelV4, index: number) =>
  model.doStreamCalls[index]?.tools?.map(({ name }) => name);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe('modes and sites', () => {
  it('adds a prompt’s site once, and puts the mode and sites in each call’s scope', async () => {
    const { engine, scopes, send } = await setup([calls(['look', 'c1']), text('a'), text('b')]);
    const session = await engine.create({ model: 'test/model' });

    await send(session.id, { site: 'https://www.shop.example/cart' });
    await send(session.id, { site: 'https://shop.example/' });
    await send(session.id, { site: 'chrome://extensions' });

    expect((await engine.sessions.get(session.id))?.sites).toEqual(['shop.example']);
    expect(scopes).toEqual([expect.objectContaining({ mode: 'build', sites: ['shop.example'] })]);
  });

  it('switches a chat to Plan with its reminder, hides input tools, and reminds on leaving', async () => {
    const { engine, model, send } = await setup([text('a'), text('b'), text('c')]);
    const session = await engine.create({ model: 'test/model' });
    const other = await engine.create({ model: 'test/model' });

    await send(session.id, { mode: 'plan' });
    await send(other.id);

    expect((await engine.sessions.get(session.id))?.mode).toBe('plan');
    expect((await engine.sessions.get(other.id))?.mode).toBeUndefined();
    expect(synthetic(await engine.messages(session.id))).toEqual([PLAN_ENTER]);
    expect(offered(model, 0)).toEqual(['look', 'wait']);
    expect(offered(model, 1)).toEqual(['look', 'poke', 'wait']);

    await send(session.id, { mode: 'build' });

    expect(synthetic(await engine.messages(session.id))).toEqual([PLAN_ENTER, PLAN_LEAVE]);
    expect(offered(model, 2)).toEqual(['look', 'poke', 'wait']);
  });

  it('reminds a chat created in Plan on its first prompt, once', async () => {
    const { engine, send } = await setup([text('a'), text('b')]);
    const session = await engine.create({ model: 'test/model', mode: 'plan' });

    await send(session.id);
    await send(session.id);

    expect(synthetic(await engine.messages(session.id))).toEqual([PLAN_ENTER]);
  });
});

describe('compaction in Plan', () => {
  it('compacts with Plan’s tools, and writes Plan’s reminder again after the checkpoint', async () => {
    const { engine, model, send } = await setup([
      text('a'),
      text('## Objective\n- Plan'),
      text('b'),
    ]);

    const session = await engine.create({ model: 'test/model', mode: 'plan' });

    await send(session.id);

    expect(await engine.compact({ sessionID: session.id })).toEqual({ status: 'completed' });

    await send(session.id);

    const messages = await engine.messages(session.id);

    expect(messages.map(({ type }) => type)).toEqual([
      'synthetic',
      'user',
      'assistant',
      'idle',
      'compaction',
      'synthetic',
      'user',
      'assistant',
      'idle',
    ]);

    expect(synthetic(messages)).toEqual([PLAN_ENTER, PLAN_ENTER]);
    expect(offered(model, 1)).toEqual(['look', 'wait']);
    expect(offered(model, 2)).toEqual(['look', 'wait']);
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('You are in Plan mode');
  });
});

describe('denials', () => {
  it('ends the turn interrupted on a plain Deny, failing the other calls', async () => {
    const { engine, model, send } = await setup([calls(['poke', 'c1'], ['wait', 'c2'])], {
      c1: new ToolError('declined', 'The user declined this tool call.'),
    });

    const session = await engine.create({ model: 'test/model' });

    await send(session.id);

    const messages = await engine.messages(session.id);
    const [assistant] = messages.filter((m): m is AssistantMessage => m.type === 'assistant');

    expect(model.doStreamCalls).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ type: 'idle', outcome: 'interrupted' });

    expect(assistant?.content).toMatchObject([
      { id: 'c1', state: { status: 'error', error: { message: TOOL_DECLINED, code: 'declined' } } },
      { id: 'c2', state: { status: 'error', error: { code: 'cancelled' } } },
    ]);

    expect(toUIMessages(messages)[1]?.parts[1]).toMatchObject({
      state: 'output-denied',
      approval: { id: 'c1', approved: false, reason: TOOL_DECLINED },
    });
  });

  it('lets the model continue after a denied call', async () => {
    const { engine, model, send } = await setup([calls(['poke', 'c1']), text('Ok')], {
      c1: new ToolError('denied', 'The user denied this: use search'),
    });

    const session = await engine.create({ model: 'test/model' });

    await send(session.id);

    const messages = await engine.messages(session.id);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('use search');
    expect(messages.at(-1)).toMatchObject({ type: 'idle', outcome: 'succeeded' });
  });
});
