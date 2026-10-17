import 'fake-indexeddb/auto';

import { APICallError, type ModelMessage, streamText } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../storage/database';
import { COMPACTION_INTERRUPTED, NOTHING_TO_COMPACT } from './compaction';
import { NUDGE } from './compaction-prompt';
import { replay } from './reducer';
import { buildRequest } from './request';
import type { DurableEventBody, SessionMessage } from './schema';
import { createSessionStore, type SessionStore } from './store';
import { compact, type CompactInput } from './summarize';

type Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];

type Part = Stream extends ReadableStream<infer P> ? P : never;

type Prompt = MockLanguageModelV4['doStreamCalls'][number]['prompt'];

const MODEL = 'openai/gpt-5';

const SUMMARY =
  '## Objective\n- Book a flight\n\n## Browser State\n- Tab 7: Flights — https://f.test';

const reply = (text: string, input = 40): Part[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
  },
];

function scripted(steps: (Part[] | Error)[]) {
  const queue = [...steps];

  return new MockLanguageModelV4({
    doStream: () => {
      const next = queue.shift() ?? reply('(script ended)');

      if (next instanceof Error) return Promise.reject(next);

      return Promise.resolve({ stream: convertArrayToReadableStream(next) });
    },
  });
}

const overflow = () =>
  new APICallError({
    message: 'prompt is too long: 250000 tokens > 200000 maximum',
    url: 'https://api.test',
    requestBodyValues: {},
    statusCode: 400,
  });

const opened: IDBDatabase[] = [];

let store: SessionStore;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();

  const database = await openDatabase();

  opened.push(database);
  store = createSessionStore(database);

  await store.publish('s1', {
    type: 'session.created',
    info: { id: 's1', agent: 'build', model: MODEL, created: 1, updated: 1 },
  });
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

let count = 0;

async function exchange(question: string, answer: string, tokens = 100) {
  count++;

  const events: DurableEventBody[] = [
    { type: 'session.prompted', messageID: `u${count}`, parts: [{ type: 'text', text: question }] },
    { type: 'session.step.started', messageID: `a${count}`, agent: 'build', model: MODEL },
    { type: 'session.text.started', messageID: `a${count}`, partID: `p${count}` },
    { type: 'session.text.ended', messageID: `a${count}`, partID: `p${count}`, text: answer },
    {
      type: 'session.step.ended',
      messageID: `a${count}`,
      finish: 'stop',
      tokens: { input: tokens, output: 10 },
    },
    { type: 'session.idle', messageID: `i${count}`, outcome: 'succeeded' },
  ];

  for (const body of events) await store.publish('s1', body);
}

function input(language: MockLanguageModelV4, extra: Partial<CompactInput> = {}): CompactInput {
  return {
    store,
    sessionID: 's1',
    messageID: `c${++count}`,
    reason: 'manual',
    model: { ref: MODEL, language, reasoning: 'strip', limit: { context: 200_000, output: 8_000 } },
    system: 'You are Sidekick.',
    tools: [],
    keep: 20,
    signal: new AbortController().signal,
    clock: { now: () => 0, random: () => 0.5, sleep: () => Promise.resolve() },
    ...extra,
  };
}

const lastText = (prompt: Prompt | undefined) => JSON.stringify(prompt?.at(-1));

async function stepPrompt(messages: ModelMessage[]) {
  const probe = scripted([reply('ok')]);
  const result = streamText({ model: probe, system: 'You are Sidekick.', messages, tools: {} });

  for await (const _ of result.fullStream);

  return probe.doStreamCalls[0]?.prompt ?? [];
}

const compactions = (messages: SessionMessage[]) =>
  messages.filter((message) => message.type === 'compaction');

describe('compact', () => {
  it('sends the step’s own request up to the split, then the prompt, and stores the checkpoint', async () => {
    await exchange('Find flights to Lisbon', 'Opened the flights site.');
    await exchange('Pick the cheapest', 'The cheapest is TAP at 120.');

    const model = scripted([reply(SUMMARY)]);
    const step = await stepPrompt(
      buildRequest({ messages: await store.messages('s1'), reasoning: 'strip' }),
    );

    expect(await compact(input(model))).toEqual({ status: 'completed' });

    const sent = model.doStreamCalls[0]?.prompt ?? [];

    expect(sent.slice(0, -1)).toEqual(step.slice(0, sent.length - 1));
    expect(sent.length - 1).toBeLessThan(step.length);
    expect(lastText(sent)).toContain('You MUST summarize the conversation above');
    expect(lastText(sent)).toContain('## Browser State');

    const [checkpoint] = compactions(await store.messages('s1'));

    expect(checkpoint).toMatchObject({
      status: 'completed',
      reason: 'manual',
      summary: SUMMARY,
      recent: '[User]: Pick the cheapest\n\n[Assistant]: The cheapest is TAP at 120.',
      model: MODEL,
      tokens: { input: 40, output: 10 },
    });
  });

  it('nudges a reply without the template once, then fails', async () => {
    await exchange('One', 'A');
    await exchange('Two', 'B');

    const model = scripted([reply('Sure!'), reply('Still no headings')]);

    expect(await compact(input(model))).toEqual({
      status: 'failed',
      error: {
        type: 'compaction',
        message: 'Compaction summary did not match the required template',
      },
    });

    expect(model.doStreamCalls).toHaveLength(2);
    expect(lastText(model.doStreamCalls[1]?.prompt)).toContain(NUDGE);

    expect(compactions(await store.messages('s1'))).toMatchObject([
      { status: 'failed', tokens: { input: 80, output: 20 } },
    ]);
  });

  it('opens a second summary with the first checkpoint and asks for an update', async () => {
    await exchange('One', 'A');
    await exchange('Two', 'B');
    await compact(input(scripted([reply(SUMMARY)])));
    await exchange('Three', 'C');
    await exchange('Four', 'D');

    const model = scripted([reply('## Objective\n- Updated')]);

    await compact(input(model));

    const sent = JSON.stringify(model.doStreamCalls[0]?.prompt);

    expect(sent.indexOf('<conversation-checkpoint>')).toBeLessThan(sent.indexOf('Three'));
    expect(sent).toContain('Book a flight');
    expect(lastText(model.doStreamCalls[0]?.prompt)).toContain('Update the existing checkpoint');

    expect(compactions(await store.messages('s1')).at(-1)).toMatchObject({
      summary: '## Objective\n- Updated',
      recent: '[User]: Four\n\n[Assistant]: D',
    });
  });

  it('flattens an over-budget request to text, dropping the oldest exchange', async () => {
    await exchange('x'.repeat(12_000), 'First answer');
    await exchange('Second question', 'Second answer');
    await exchange('Third', 'C');

    const model = scripted([reply(SUMMARY)]);
    const small = { context: 3_200, output: 8_000 };

    await compact(
      input(model, { model: { ...input(model).model, limit: small }, buffer: 0, keep: 8 }),
    );

    const sent = model.doStreamCalls[0]?.prompt ?? [];

    const flattened = JSON.stringify(sent[1]);

    expect(sent).toHaveLength(3);
    expect(flattened).toContain('[1 older exchange omitted]');
    expect(flattened).toContain('[User]: Second question\\n[Assistant]: Second answer');
    expect(JSON.stringify(sent)).not.toContain('xxxx');
  });

  it('retries a rejected summary at 70% of its size', async () => {
    await exchange('x'.repeat(12_000), 'First answer');
    await exchange('Second question', 'Second answer');
    await exchange('Third', 'C');

    const model = scripted([overflow(), reply(SUMMARY)]);

    expect(await compact(input(model, { keep: 8 }))).toEqual({ status: 'completed' });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('xxxx');
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('[1 older exchange omitted]');
  });

  it('writes nothing with nothing to compact, and fails an aborted one as interrupted', async () => {
    const empty = scripted([]);

    expect(await compact(input(empty))).toEqual({ status: 'empty' });
    expect(await store.messages('s1')).toEqual([]);
    expect(NOTHING_TO_COMPACT).toBe('Nothing to compact yet');

    await exchange('One', 'A');

    const controller = new AbortController();

    controller.abort();

    expect(await compact(input(scripted([reply(SUMMARY)]), { signal: controller.signal }))).toEqual(
      {
        status: 'aborted',
      },
    );

    expect(compactions(await store.messages('s1'))).toMatchObject([
      { status: 'failed', error: { type: 'aborted', message: COMPACTION_INTERRUPTED } },
    ]);
  });

  it('keeps every stored event, and replays all three states to the same rows', async () => {
    await exchange('One', 'A');
    await exchange('Two', 'B');

    const before = JSON.stringify(await store.events('s1'));

    await compact(input(scripted([reply(SUMMARY)])));
    await exchange('Three', 'C');
    await compact(input(scripted([reply('no'), reply('no')])));

    const events = await store.events('s1');

    expect(JSON.stringify(events).startsWith(before.slice(0, -1))).toBe(true);

    expect(
      events.filter(({ type }) => type.startsWith('session.compaction.')).map(({ type }) => type),
    ).toEqual([
      'session.compaction.started',
      'session.compaction.ended',
      'session.compaction.started',
      'session.compaction.failed',
    ]);

    const projection = replay(events.slice(0, -1));

    expect(
      [...projection.messages.values()].filter(({ type }) => type === 'compaction'),
    ).toMatchObject([{ status: 'completed' }, { status: 'running', reason: 'manual' }]);

    expect([...replay(events).messages.values()].sort((a, b) => a.seq - b.seq)).toEqual(
      await store.messages('s1'),
    );
  });
});
