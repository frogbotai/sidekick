import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../storage/database';
import { reduce, replay } from './reducer';
import { broadcastRelay } from './relay';
import type { DurableEventBody, LogEvent, SessionInfo } from './schema';
import { createSessionStore, type SessionStore } from './store';

const opened: IDBDatabase[] = [];

async function open(options?: Parameters<typeof createSessionStore>[1]) {
  const database = await openDatabase();

  opened.push(database);

  return createSessionStore(database, options);
}

function info(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, agent: 'build', model: 'openai/gpt-5', created: 1, updated: 1, ...extra };
}

const TURN: DurableEventBody[] = [
  {
    type: 'session.prompted',
    messageID: 'msg_u1',
    parts: [{ type: 'text', text: 'Find flights' }],
  },
  { type: 'session.step.started', messageID: 'msg_a1', agent: 'build', model: 'openai/gpt-5' },
  { type: 'session.reasoning.started', messageID: 'msg_a1', partID: 'r1' },
  { type: 'session.reasoning.ended', messageID: 'msg_a1', partID: 'r1', text: 'Look at the tabs' },
  { type: 'session.tool.input.started', messageID: 'msg_a1', callID: 'c1', name: 'tabs_list' },
  {
    type: 'session.tool.called',
    messageID: 'msg_a1',
    callID: 'c1',
    name: 'tabs_list',
    input: {},
  },
  {
    type: 'session.tool.success',
    messageID: 'msg_a1',
    callID: 'c1',
    output: [{ tab_id: 1, url: 'https://example.com' }],
  },
  { type: 'session.step.ended', messageID: 'msg_a1', finish: 'tool-calls' },
  { type: 'session.step.started', messageID: 'msg_a2', agent: 'build', model: 'openai/gpt-5' },
  { type: 'session.text.started', messageID: 'msg_a2', partID: 't1' },
  { type: 'session.text.ended', messageID: 'msg_a2', partID: 't1', text: 'One tab is open.' },
  { type: 'session.step.ended', messageID: 'msg_a2', finish: 'stop', tokens: { input: 10 } },
  { type: 'session.idle', messageID: 'msg_i1', outcome: 'succeeded' },
];

async function record(store: SessionStore, id = 's1') {
  await store.publish(id, { type: 'session.created', info: info(id) });

  for (const body of TURN) await store.publish(id, body);
}

async function stored(store: SessionStore, id: string) {
  return { session: await store.sessions.get(id), messages: await store.messages(id) };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe('createSessionStore', () => {
  it('folds a recorded log into the projection, and replaying it rebuilds the same rows', async () => {
    const store = await open();

    await record(store);

    const { session, messages } = await stored(store, 's1');

    expect(messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'assistant',
      'idle',
    ]);

    expect(messages[1]).toMatchObject({
      content: [
        { type: 'reasoning', id: 'r1', text: 'Look at the tabs' },
        {
          type: 'tool',
          id: 'c1',
          name: 'tabs_list',
          state: { status: 'completed', output: [{ tab_id: 1, url: 'https://example.com' }] },
        },
      ],
      finish: 'tool-calls',
    });

    const events = await store.events('s1');

    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));

    const projection = replay(events);

    expect(projection.sessions.get('s1')).toEqual(session);
    expect([...projection.messages.values()]).toEqual(messages);
  });

  it('rolls an event back when its projector throws', async () => {
    const store = await open({
      reducer: (target, event) => {
        if (event.type === 'session.idle') throw new Error('projector failed');

        return reduce(target, event);
      },
    });

    await store.publish('s1', { type: 'session.created', info: info('s1') });

    await expect(
      store.publish('s1', { type: 'session.idle', messageID: 'msg_i', outcome: 'failed' }),
    ).rejects.toThrow('projector failed');

    expect((await store.events('s1')).map((event) => event.type)).toEqual(['session.created']);
    expect(await store.messages('s1')).toEqual([]);

    const next = await store.publish('s1', { type: 'session.renamed', title: 'Kept' });

    expect(next.seq).toBe(2);
  });

  it('truncates a message and every later one', async () => {
    const store = await open();

    await record(store);
    await store.publish('s1', { type: 'session.truncated', messageID: 'msg_a2' });

    expect((await store.messages('s1')).map((message) => message.id)).toEqual(['msg_u1', 'msg_a1']);
    expect([...replay(await store.events('s1')).messages.keys()]).toEqual(['msg_u1', 'msg_a1']);
  });

  it('records model-switched with the previous model and updates the session', async () => {
    const store = await open();

    await store.publish('s1', { type: 'session.created', info: info('s1') });

    await store.publish('s1', {
      type: 'session.model.selected',
      messageID: 'msg_m',
      model: 'anthropic/claude-haiku-4-5',
    });

    expect((await store.sessions.get('s1'))?.model).toBe('anthropic/claude-haiku-4-5');

    expect(await store.messages('s1')).toMatchObject([
      { type: 'model-switched', model: 'anthropic/claude-haiku-4-5', previous: 'openai/gpt-5' },
    ]);
  });

  it('replays after a seq, then follows live events, deltas included', async () => {
    const store = await open();

    await record(store);

    const controller = new AbortController();
    const seen: LogEvent[] = [];
    const log = store.log({ sessionID: 's1', after: 12, follow: true, signal: controller.signal });

    const reading = (async () => {
      for await (const event of log) {
        seen.push(event);

        if (event.type === 'session.renamed') controller.abort();
      }
    })();

    await expect.poll(() => seen.length).toBe(2);

    store.emit('s1', { type: 'session.text.delta', messageID: 'msg_a2', partID: 't1', delta: 'x' });
    await store.publish('s1', { type: 'session.renamed', title: 'Flights' });
    await reading;

    expect(seen.map((event) => event.type)).toEqual([
      'session.step.ended',
      'session.idle',
      'session.text.delta',
      'session.renamed',
    ]);
  });

  it('follows from the head, seeing only events after the subscription', async () => {
    const store = await open();

    await record(store);

    const head = await store.head('s1');
    const controller = new AbortController();
    const seen: string[] = [];
    const log = store.log({
      sessionID: 's1',
      after: head,
      follow: true,
      signal: controller.signal,
    });

    const reading = (async () => {
      for await (const event of log) {
        seen.push(event.type);

        if (event.type === 'session.renamed') controller.abort();
      }
    })();

    expect(head).toBe(TURN.length + 1);
    expect(await store.head('none')).toBe(0);

    await store.publish('s1', { type: 'session.renamed', title: 'Flights' });
    await reading;

    expect(seen).toEqual(['session.renamed']);
  });

  it('relays one window’s live events to another’s followers, in order and never echoed', async () => {
    const database = await openDatabase();
    const channel = `sidekick.session.test.${crypto.randomUUID()}`;
    const relays = [broadcastRelay(channel), broadcastRelay(channel)];
    const [a, b] = relays.map((relay) => createSessionStore(database, { relay }));

    opened.push(database);

    if (!a || !b) throw new Error('No stores');

    await a.publish('s1', { type: 'session.created', info: info('s1') });

    const heard: string[] = [];
    const own: string[] = [];
    const listed: string[] = [];

    a.watch((event) => own.push(event.type));
    b.watch((event) => listed.push(`${event.sessionID}:${event.type}`));

    const controller = new AbortController();

    const log = b.log({
      sessionID: 's1',
      after: await b.head('s1'),
      follow: true,
      signal: controller.signal,
    });

    const reading = (async () => {
      for await (const event of log) {
        heard.push(event.type);

        if (event.type === 'session.step.ended') controller.abort();
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));

    await a.publish('s1', {
      type: 'session.step.started',
      messageID: 'msg_a1',
      agent: 'build',
      model: 'openai/gpt-5',
    });

    await a.publish('s1', { type: 'session.text.started', messageID: 'msg_a1', partID: 't1' });
    a.emit('s1', { type: 'session.text.delta', messageID: 'msg_a1', partID: 't1', delta: 'He' });
    a.emit('s1', { type: 'session.text.delta', messageID: 'msg_a1', partID: 't1', delta: 'y' });
    await a.publish('s1', { type: 'session.step.ended', messageID: 'msg_a1', finish: 'stop' });
    await a.publish('s2', { type: 'session.created', info: info('s2') });
    await reading;

    await expect.poll(() => listed.at(-1)).toBe('s2:session.created');

    for (const relay of relays) relay.close();

    expect(heard).toEqual([
      'session.step.started',
      'session.text.started',
      'session.text.delta',
      'session.text.delta',
      'session.step.ended',
    ]);

    expect(own).toEqual([...heard, 'session.created']);
  });

  it('lists root sessions newest first, renames, and deletes events and projection', async () => {
    const store = await open();

    await store.publish('a', { type: 'session.created', info: info('a', { updated: 1 }) });
    await store.publish('b', { type: 'session.created', info: info('b', { updated: 5 }) });

    await store.publish('child', {
      type: 'session.created',
      info: info('child', { parentID: 'a', updated: 9 }),
    });

    expect((await store.sessions.list()).map(({ id }) => id)).toEqual(['b', 'a']);
    expect((await store.sessions.list({ parentID: 'a' })).map(({ id }) => id)).toEqual(['child']);

    await store.sessions.rename('a', 'Trip');

    expect((await store.sessions.get('a'))?.title).toBe('Trip');

    await record(store, 'b');
    await store.sessions.delete('b');

    expect(await store.sessions.get('b')).toBeUndefined();
    expect(await store.events('b')).toEqual([]);
    expect(await store.messages('b')).toEqual([]);
    expect(await store.events('a')).toHaveLength(2);
  });
});
