import 'fake-indexeddb/auto';

import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS, RESEARCH_AGENT, RESEARCH_STEPS } from '../agent/builtin';
import { createRegistry } from '../registry/registry';
import { createSessionEngine } from '../session/engine';
import type { SessionLocks } from '../session/queue';
import type { AssistantMessage, AssistantTool, SessionMessage } from '../session/schema';
import { createSessionStore } from '../session/store';
import { toUIMessages } from '../session/ui';
import { openDatabase } from '../storage/database';
import { defineTool, type ToolContext, type ToolDefinition } from '../tool/tool';
import { SUBAGENT_PREAMBLE, subagentTool } from './tool';

type Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];

type Part = Stream extends ReadableStream<infer P> ? P : never;

type Script = Part[] | (() => Promise<Part[]>);

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

const call = (toolName: string, input: object, toolCallId = 'call-1'): Part[] => [
  { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
  finish('tool-calls'),
];

const dispatch = (input: Record<string, string>, callID = 'call-1') =>
  call(
    'subagent',
    { agent: RESEARCH_AGENT, description: 'Chrome 142 changes', prompt: 'Go', ...input },
    callID,
  );

function memoryLocks(): SessionLocks {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();

  return {
    run: (name, ifAvailable, work) => {
      if (ifAvailable && held.has(name)) return Promise.resolve(undefined);

      const next = (tails.get(name) ?? Promise.resolve()).then(async () => {
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

const badRequest = new APICallError({
  message: 'Bad request',
  url: 'https://api.test',
  requestBodyValues: {},
  statusCode: 400,
});

const opened: IDBDatabase[] = [];

const contexts: ToolContext[] = [];

const look = defineTool({
  id: 'snapshot',
  description: 'Read the page.',
  input: z.object({}),
  output: z.object({}),
  permission: 'read',
  execute: (_, ctx) => {
    contexts.push(ctx);

    return Promise.resolve({ output: {} });
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

interface Setup {
  steps?: Script[];
  agents?: AgentInfo[];
  mode?: string;
}

async function setup({ steps = [], agents = [...BUILTIN_AGENTS], mode }: Setup = {}) {
  const database = await openDatabase();

  opened.push(database);

  const store = createSessionStore(database);
  const queue = [...steps];

  const model = new MockLanguageModelV4({
    doStream: async () => {
      const next = queue.shift() ?? text('(script ended)');

      return {
        stream: convertArrayToReadableStream(typeof next === 'function' ? await next() : next),
      };
    },
    doGenerate: () => Promise.reject(new Error('No title model')),
  });

  const toolRegistry = createRegistry<ToolDefinition>('tools');
  const agentRegistry = createRegistry<AgentInfo>('agents');
  const asserts: string[] = [];
  let now = 1_000;

  agentRegistry.register('test', (draft) => {
    for (const agent of agents) draft.add(agent);
  });

  const models = {
    resolve: () => Promise.resolve({ language: model, reasoning: 'strip' as const }),
    list: () =>
      Promise.resolve([
        {
          providerID: 'google',
          id: 'gemini-flash',
          name: 'Flash',
          route: '@ai-sdk/google',
          variants: [{ id: 'high', options: {} }],
        },
      ]),
  };

  const engine = createSessionEngine({
    store,
    models,
    tools: toolRegistry,
    agents: agentRegistry,
    permission: {
      assert: (request, scope) => {
        asserts.push(`${scope.agent}:${request.action}:${request.resource}`);

        return Promise.resolve();
      },
    },
    clock: { now: () => now++, random: () => 0.5, sleep: () => Promise.resolve() },
    locks: memoryLocks(),
  });

  toolRegistry.register('test', (draft) => {
    for (const definition of [
      look,
      hang,
      subagentTool({ engine, agents: agentRegistry, models }),
    ]) {
      draft.add(definition);
    }
  });

  const session = await engine.create({ model: 'openai/gpt-luna', ...(mode ? { mode } : {}) });

  return { store, engine, model, session, asserts };
}

async function send(engine: Awaited<ReturnType<typeof setup>>['engine'], sessionID: string) {
  const sent = await engine.prompt({ sessionID, parts: [{ type: 'text', text: 'Research it' }] });

  await sent.done;
}

function tools(messages: readonly SessionMessage[]) {
  return messages
    .filter((message): message is AssistantMessage => message.type === 'assistant')
    .flatMap((message) => message.content)
    .filter((part): part is AssistantTool => part.type === 'tool');
}

function promptText(options: MockLanguageModelV4['doStreamCalls'][number] | undefined) {
  return JSON.stringify(options?.prompt ?? []);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  contexts.length = 0;
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe('subagent', () => {
  it('runs research in a child and returns its last text, wrapped in <subagent>', async () => {
    const { engine, session, model, asserts } = await setup({
      mode: 'plan',
      steps: [dispatch({}), text('# Report\n\nChrome 142 [1]'), text('Here it is')],
    });

    await send(engine, session.id);

    const [child] = await engine.sessions.list({ parentID: session.id });

    if (!child) throw new Error('No child session');

    expect(child).toMatchObject({
      agent: RESEARCH_AGENT,
      title: 'Chrome 142 changes',
      model: 'openai/gpt-luna',
      mode: 'plan',
    });

    expect(await engine.sessions.list()).toEqual([expect.objectContaining({ id: session.id })]);
    expect(promptText(model.doStreamCalls[1])).toContain(`${SUBAGENT_PREAMBLE}\\nGo`);
    expect(asserts).toContain(`build:subagent:${RESEARCH_AGENT}`);

    const [part] = tools(await engine.messages(session.id));

    expect(part).toMatchObject({
      name: 'subagent',
      metadata: { sessionID: child.id },
      state: {
        status: 'completed',
        output: { sessionID: child.id, status: 'completed' },
        content: [
          {
            type: 'text',
            text: `<subagent sessionID="${child.id}" state="completed">\n# Report\n\nChrome 142 [1]\n</subagent>`,
          },
        ],
      },
    });

    const ui = toUIMessages(await engine.messages(session.id));

    expect(JSON.stringify(ui)).toContain(`"toolMetadata":{"sessionID":"${child.id}"}`);
  });

  it('lists only the subagents the caller may dispatch in its description', async () => {
    const { engine, session, model } = await setup({ steps: [text('ok')] });

    await send(engine, session.id);

    const offered = model.doStreamCalls[0]?.tools?.find((tool) => tool.name === 'subagent');
    const description = offered && 'description' in offered ? offered.description : '';

    expect(description).toContain('Available subagents:');
    expect(description).toContain('- explore: ');
    expect(description).toContain('- research: Deep research on the web');
    expect(description).not.toContain('- title');
  });

  it.each([
    [{ agent: 'ghost' }, 'Unknown agent: ghost'],
    [{ agent: 'build' }, 'Agent build cannot run as a subagent'],
    [{ model: 'nobody/none' }, 'Model "nobody/none" is not connected. Omit the model.'],
    [{ model: 'google/gemini-flash#max' }, 'Variant "max" is not available'],
    [{ sessionID: 'ses_missing' }, 'Subagent session not found: ses_missing'],
  ])('refuses %j as a tool error', async (input, message) => {
    const { engine, session } = await setup({ steps: [dispatch(input), text('ok')] });

    await send(engine, session.id);

    const [part] = tools(await engine.messages(session.id));

    expect(part?.state).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining(message) },
    });

    expect(await engine.sessions.list({ parentID: session.id })).toEqual([]);
  });

  it('refuses a sessionID that is not its child', async () => {
    let other = '';

    const { engine, session } = await setup({
      steps: [() => Promise.resolve(dispatch({ sessionID: other })), text('ok')],
    });

    other = (await engine.create({ model: 'openai/gpt-luna' })).id;
    await send(engine, session.id);

    const [part] = tools(await engine.messages(session.id));

    expect(part?.state).toMatchObject({
      status: 'error',
      error: { message: `Session ${other} is not a child of the current session` },
    });
  });

  it('refuses a caller that is itself a subagent', async () => {
    const open = BUILTIN_AGENTS.map((agent) =>
      agent.id === RESEARCH_AGENT ? { ...agent, permissions: [] } : agent,
    );

    const { engine, session } = await setup({
      agents: open,
      steps: [
        dispatch({}),
        call('subagent', { agent: 'explore', description: 'x', prompt: 'y' }),
        text('child'),
        text('done'),
      ],
    });

    await send(engine, session.id);

    const [child] = await engine.sessions.list({ parentID: session.id });
    const [nested] = tools(await engine.messages(child?.id ?? ''));

    expect(nested?.state).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('Subagent depth limit reached (1)') },
    });
  });

  it('uses the override, then the agent’s model, then the parent’s', async () => {
    const withModel = BUILTIN_AGENTS.map((agent) =>
      agent.id === RESEARCH_AGENT ? { ...agent, model: 'google/gemini-flash' } : agent,
    );

    const childModel = async (agents: AgentInfo[], input: Record<string, string>) => {
      const { engine, session } = await setup({
        agents,
        steps: [dispatch(input), text('r'), text('d')],
      });

      await send(engine, session.id);

      const [child] = await engine.sessions.list({ parentID: session.id });
      const steps = (await engine.messages(child?.id ?? '')).filter(
        (message) => message.type === 'assistant',
      );

      return { session: child?.model, steps: steps.map((step) => step.model) };
    };

    expect(await childModel(withModel, { model: 'google/gemini-flash#high' })).toEqual({
      session: 'google/gemini-flash#high',
      steps: ['google/gemini-flash#high'],
    });

    expect(await childModel(withModel, {})).toEqual({
      session: 'google/gemini-flash',
      steps: ['google/gemini-flash'],
    });

    expect(await childModel([...BUILTIN_AGENTS], {})).toEqual({
      session: 'openai/gpt-luna',
      steps: ['openai/gpt-luna'],
    });
  });

  it('fails the call, naming the child, when the child fails', async () => {
    const { engine, session } = await setup({
      steps: [dispatch({}), () => Promise.reject(badRequest), text('sorry')],
    });

    await send(engine, session.id);

    const [child] = await engine.sessions.list({ parentID: session.id });
    const [part] = tools(await engine.messages(session.id));

    expect(part?.state).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining(`Subagent failed (sessionID: ${child?.id})`) },
    });
  });

  it('continues its own child with the next prompt and no preamble', async () => {
    let childID = '';

    const { engine, session, model } = await setup({
      steps: [
        dispatch({}),
        text('one'),
        text('done'),
        () => Promise.resolve(dispatch({ sessionID: childID, prompt: 'Dig deeper' }, 'call-2')),
        text('two'),
        text('done again'),
      ],
    });

    await send(engine, session.id);

    childID = (await engine.sessions.list({ parentID: session.id }))[0]?.id ?? '';

    await send(engine, session.id);

    expect(await engine.sessions.list({ parentID: session.id })).toHaveLength(1);
    expect(promptText(model.doStreamCalls[4])).toContain('Dig deeper');
    expect(promptText(model.doStreamCalls[4]).split(SUBAGENT_PREAMBLE)).toHaveLength(2);
    expect(JSON.stringify(tools(await engine.messages(session.id)).at(-1))).toContain('two');
  });

  it('stops the child when the parent stops, and ends both turns interrupted', async () => {
    const { engine, session } = await setup({ steps: [dispatch({}), call('hang', {})] });
    const sent = await engine.prompt({
      sessionID: session.id,
      parts: [{ type: 'text', text: 'Go' }],
    });

    let childID = '';

    await expect
      .poll(async () => {
        const [child] = await engine.sessions.list({ parentID: session.id });

        childID = child?.id ?? '';

        return child ? JSON.stringify(await engine.messages(child.id)) : '';
      })
      .toContain('"status":"running"');

    engine.abort(session.id);
    await sent.done;

    await expect
      .poll(async () => (await engine.messages(childID)).at(-1))
      .toMatchObject({ type: 'idle', outcome: 'interrupted' });

    expect((await engine.messages(session.id)).at(-1)).toMatchObject({
      type: 'idle',
      outcome: 'interrupted',
    });
  });

  it('gives the child’s tools the root chat’s id', async () => {
    const { engine, session } = await setup({
      steps: [dispatch({}), call('snapshot', {}), text('r'), text('d')],
    });

    await send(engine, session.id);

    const [child] = await engine.sessions.list({ parentID: session.id });

    expect(contexts.map((ctx) => ctx.session)).toEqual([{ id: child?.id, rootID: session.id }]);
  });

  it('deletes the children with their parent', async () => {
    const { engine, session, store } = await setup({ steps: [dispatch({}), text('r'), text('d')] });

    await send(engine, session.id);

    const [child] = await engine.sessions.list({ parentID: session.id });

    await engine.sessions.delete(session.id);

    expect(await store.sessions.get(child?.id ?? '')).toBeUndefined();
    expect(await store.messages(child?.id ?? '')).toEqual([]);
  });

  it('caps research at its step limit, the last step without tools', async () => {
    const capped = BUILTIN_AGENTS.map((agent) =>
      agent.id === RESEARCH_AGENT ? { ...agent, steps: 2 } : agent,
    );

    const { engine, session, model } = await setup({
      agents: capped,
      steps: [dispatch({}), call('snapshot', {}), text('report'), text('d')],
    });

    await send(engine, session.id);

    expect(RESEARCH_STEPS).toBe(40);
    expect(model.doStreamCalls[1]?.tools?.map((tool) => tool.name)).not.toContain('subagent');
    expect(model.doStreamCalls[2]?.toolChoice).toEqual({ type: 'none' });
    expect(promptText(model.doStreamCalls[2])).toContain('MAXIMUM STEPS REACHED');
  });
});
