import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../storage/database';
import {
  allFileName,
  EXPORT_NOTICE,
  exportFileName,
  exportLines,
  REDACTED,
  runFileName,
  runKey,
} from './export';
import type { DurableEventBody, SessionInfo } from './schema';
import { createSessionStore, type SessionStore } from './store';

const opened: IDBDatabase[] = [];

const NOW = Date.UTC(2026, 9, 24, 12);

async function open() {
  const database = await openDatabase();

  opened.push(database);

  return createSessionStore(database);
}

function info(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, agent: 'build', model: 'openai/gpt-5', created: 1, updated: 1, ...extra };
}

function turn(text: string): DurableEventBody[] {
  return [
    { type: 'session.prompted', messageID: `msg_u_${text}`, parts: [{ type: 'text', text }] },
    { type: 'session.idle', messageID: `msg_i_${text}`, outcome: 'succeeded' },
  ];
}

const FILL: DurableEventBody[] = [
  { type: 'session.step.started', messageID: 'msg_a', agent: 'build', model: 'openai/gpt-5' },
  { type: 'session.tool.input.started', messageID: 'msg_a', callID: 'c_pw', name: 'fill' },
  {
    type: 'session.tool.called',
    messageID: 'msg_a',
    callID: 'c_pw',
    name: 'fill',
    input: { tab_id: 1, ref: 'e4', text: 'hunter2' },
  },
  {
    type: 'session.tool.progress',
    messageID: 'msg_a',
    callID: 'c_pw',
    metadata: { redacted: 'true' },
  },
  { type: 'session.tool.success', messageID: 'msg_a', callID: 'c_pw', output: { ok: true } },
  { type: 'session.tool.input.started', messageID: 'msg_a', callID: 'c_name', name: 'fill' },
  {
    type: 'session.tool.called',
    messageID: 'msg_a',
    callID: 'c_name',
    name: 'fill',
    input: { tab_id: 1, ref: 'e2', text: 'Ada' },
  },
  { type: 'session.tool.success', messageID: 'msg_a', callID: 'c_name', output: { ok: true } },
  { type: 'session.step.ended', messageID: 'msg_a', finish: 'stop' },
];

async function seed(store: SessionStore, session: SessionInfo, bodies: DurableEventBody[]) {
  await store.publish(session.id, { type: 'session.created', info: session });

  for (const body of bodies) await store.publish(session.id, body);
}

interface ExportFile {
  sidekickExport: number;
  exportedAt: string;
  notice: string;
  sessions: {
    info: SessionInfo;
    messages: { type: string; content?: { id: string; state: { input: unknown } }[] }[];
    events?: { type: string; callID?: string; input?: unknown }[];
  }[];
}

const parse = (lines: string[]) => JSON.parse(lines.join('\n')) as ExportFile;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe('exportLines', () => {
  it('opens with the version, the time and the notice, and is one JSON document', async () => {
    const store = await open();

    await seed(store, info('ses_a'), turn('hi'));

    const lines = await exportLines(store, [info('ses_a')], { now: () => NOW });
    const file = parse(lines);

    expect(file).toMatchObject({
      sidekickExport: 1,
      exportedAt: '2026-10-24T12:00:00.000Z',
      notice: EXPORT_NOTICE,
    });

    expect(EXPORT_NOTICE).toContain('no API keys');
    expect(lines[0]).toContain('"sidekickExport":1');
    expect(file.sessions[0]?.messages.map(({ type }) => type)).toEqual(['user', 'idle']);
    expect(lines).toContain(JSON.stringify((await store.messages('ses_a'))[0]) + ',');
  });

  it('lists each root, then its children and grandchildren, parents first', async () => {
    const store = await open();
    const root = info('ses_root');
    const child = info('ses_child', { parentID: 'ses_root' });
    const grandchild = info('ses_grand', { parentID: 'ses_child' });
    const other = info('ses_other');

    await seed(store, root, turn('root'));
    await seed(store, child, turn('child'));
    await seed(store, grandchild, turn('grand'));
    await seed(store, other, []);

    const file = parse(await exportLines(store, [root, other]));

    expect(file.sessions.map(({ info: { id } }) => id)).toEqual([
      'ses_root',
      'ses_child',
      'ses_grand',
      'ses_other',
    ]);

    expect(file.sessions[3]?.messages).toEqual([]);
  });

  it('adds the event log only when asked', async () => {
    const store = await open();

    await seed(store, info('ses_a'), turn('hi'));

    const without = parse(await exportLines(store, [info('ses_a')]));
    const withEvents = parse(await exportLines(store, [info('ses_a')], { events: true }));

    expect(without.sessions[0]).not.toHaveProperty('events');

    expect(withEvents.sessions[0]?.events?.map(({ type }) => type)).toEqual([
      'session.created',
      'session.prompted',
      'session.idle',
    ]);
  });

  it('writes a fill into a redacted field as [redacted], and the store keeps the text', async () => {
    const store = await open();

    await seed(store, info('ses_a'), FILL);

    const file = parse(await exportLines(store, [info('ses_a')], { events: true }));
    const tools = file.sessions[0]?.messages.flatMap(({ content = [] }) => content) ?? [];
    const called = file.sessions[0]?.events?.filter(({ type }) => type === 'session.tool.called');

    expect(tools.map(({ id, state }) => [id, state.input])).toEqual([
      ['c_pw', { tab_id: 1, ref: 'e4', text: REDACTED }],
      ['c_name', { tab_id: 1, ref: 'e2', text: 'Ada' }],
    ]);

    expect(called?.map(({ callID, input }) => [callID, input])).toEqual([
      ['c_pw', { tab_id: 1, ref: 'e4', text: REDACTED }],
      ['c_name', { tab_id: 1, ref: 'e2', text: 'Ada' }],
    ]);

    const [message] = (await store.messages('ses_a')).filter(({ type }) => type === 'assistant');
    const events = await store.events('ses_a');

    expect(JSON.stringify(message)).toContain('hunter2');
    expect(JSON.stringify(events)).toContain('hunter2');
  });
});

describe('file names', () => {
  const session = info('ses_0mh3k2x1f0000k3v9x2ab', {
    title: 'Fix DNS records: “example.com”',
    created: new Date(2026, 9, 24, 23, 30).getTime(),
  });

  it('names an export after the slugged title, else the ID', () => {
    expect(exportFileName(session)).toBe('fix-dns-records-example-com.json');
    expect(exportFileName({ id: session.id })).toBe('ses_0mh3k2x1f0000k3v9x2ab.json');

    expect(exportFileName({ id: session.id, title: '***' })).toBe('ses_0mh3k2x1f0000k3v9x2ab.json');
  });

  it('names a run by its local start day, the slug and the ID’s random last 8', () => {
    expect(runKey(session)).toBe('k3v9x2ab');
    expect(runFileName(session)).toBe('2026-10-24-fix-dns-records-example-com-k3v9x2ab.json');

    expect(runFileName({ id: session.id, created: session.created })).toBe(
      '2026-10-24-ses_0mh3k2x1f0000k3v9x2ab-k3v9x2ab.json',
    );
  });

  it('names Export all after the local day', () => {
    expect(allFileName(new Date(2026, 0, 5, 1).getTime())).toBe(
      'sidekick-sessions-2026-01-05.json',
    );
  });
});
