import { type AgentInfo, lockName } from '@frogbotai/sidekick-core';
import type { ProviderModel } from '@frogbotai/sidekick-core/provider';
import { describe, expect, it } from 'vitest';

import { chatManifest, createChatAdapter, heldLocks } from './adapter';
import { fakeEngine } from './fakeEngine';
import type { WindowChat } from './transport';

const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  mode: 'primary',
  hidden: false,
  permissions: [],
  ...extra,
});

const model = (providerID: string, id: string, name: string): ProviderModel => ({
  providerID,
  id,
  name,
  route: '@ai-sdk/openai',
  family: id,
  variants: [],
});

function openChat(current?: string): WindowChat & { opened: (string | undefined)[] } {
  let open = current;
  const opened: (string | undefined)[] = [];

  return {
    opened,
    current: () => open,
    open: (sessionID) => {
      opened.push(sessionID);
      open = sessionID;

      return Promise.resolve();
    },
  };
}

describe('chatManifest', () => {
  it('lists primary, non-hidden agents with the connected models, and is null with none', () => {
    const agents = [
      agent('build'),
      agent('title', { hidden: true }),
      agent('explore', { mode: 'subagent' }),
      agent('plan', { mode: 'all' }),
    ];

    const models = [model('openai', 'gpt-5', 'GPT-5'), model('anthropic', 'haiku', 'Haiku')];

    expect(chatManifest(agents, models)).toEqual({
      defaultAgent: 'build',
      transcribe: false,
      agents: ['build', 'plan'].map((slug) => ({
        slug,
        label: slug === 'build' ? 'Build' : 'Plan',
        source: 'config',
        defaultModel: 'openai/gpt-5',
        models: ['openai/gpt-5', 'anthropic/haiku'],
        names: { 'openai/gpt-5': 'GPT-5', 'anthropic/haiku': 'Haiku' },
      })),
    });

    expect(chatManifest(agents, [])).toBeNull();
    expect(chatManifest([agent('title', { hidden: true })], models)).toBeNull();
  });
});

describe('createChatAdapter', () => {
  const manifest = chatManifest([agent('build')], [model('openai', 'gpt-5', 'GPT-5')]);

  it('loads a chat as running while another window holds its lock', async () => {
    const { engine } = fakeEngine();
    const held = new Set([lockName('ses_1')]);
    const adapter = createChatAdapter({
      engine,
      chat: openChat(),
      manifest,
      locks: () => Promise.resolve(held),
    });

    expect(await adapter.loadTurnState?.('build', 'ses_1')).toBe('running');

    held.clear();

    expect(await adapter.loadTurnState?.('build', 'ses_1')).toBe('idle');
    expect(adapter.uploadAttachment).toBeUndefined();
    expect(adapter.transcribe).toBeUndefined();
    expect(adapter.branchChat).toBeUndefined();
    expect(adapter.dismissToolCall).toBeUndefined();
  });

  it('reads held lock names from navigator.locks.query()', async () => {
    const manager = {
      query: () => Promise.resolve({ held: [{ name: lockName('ses_1') }, {}], pending: [] }),
      request: () => Promise.reject(new Error('unused')),
    };

    expect(await heldLocks(manager)).toEqual(new Set([lockName('ses_1')]));
  });

  it('marks a message queued only while another window holds the lock', async () => {
    const send = async (takenDuringQuery: boolean) => {
      const fake = fakeEngine();
      let mine = false;
      const adapter = createChatAdapter({
        engine: fake.engine,
        chat: openChat('ses_1'),
        manifest,
        busy: () => mine,
        locks: () => {
          if (takenDuringQuery) mine = true;

          return Promise.resolve(new Set([lockName('ses_1')]));
        },
      });

      const transport = adapter.createTransport({
        agent: 'build',
        request: () => ({ chatId: 'ses_1', model: 'openai/gpt-5' }),
        onChatId: () => undefined,
      });

      const waiting = new AbortController();

      fake.hold();

      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'ses_1',
        messageId: undefined,
        messages: [{ id: 'msg_q', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
        abortSignal: waiting.signal,
      });

      waiting.abort();

      const chunks: unknown[] = [];

      for await (const chunk of stream) chunks.push(chunk);

      return chunks.map((chunk) => (chunk as { type: string }).type);
    };

    expect(await send(true)).toEqual(['abort']);
    expect(await send(false)).toEqual(['data-queued', 'abort']);
  });

  it('lists every chat whatever the agent, and renames and deletes', async () => {
    const fake = fakeEngine();

    fake.sessions.set('ses_2', { ...fake.sessions.get('ses_1')!, id: 'ses_2', agent: 'plan' });

    const chat = openChat('ses_2');
    const adapter = createChatAdapter({ engine: fake.engine, chat, manifest });
    const page = await adapter.listChats({ agent: 'build', page: 1, limit: 20 });

    expect(page.docs.map(({ id }) => id)).toEqual(['ses_1', 'ses_2']);
    expect(page).toMatchObject({ totalDocs: 2, totalPages: 1, hasNextPage: false });
    expect(await adapter.renameChat?.('ses_1', 'Trip')).toMatchObject({ title: 'Trip' });

    await adapter.deleteChat?.('ses_2');

    expect(chat.opened).toEqual([undefined]);
    expect(fake.calls).toContain('delete:ses_2');
  });

  it('loads queued messages beside the stored ones', async () => {
    const fake = fakeEngine();
    const adapter = createChatAdapter({ engine: fake.engine, chat: openChat(), manifest });

    fake.hold();

    await fake.engine.prompt({
      sessionID: 'ses_1',
      messageID: 'msg_q',
      parts: [{ type: 'text', text: 'Later' }],
    });

    expect(await adapter.loadMessages('ses_1')).toEqual({
      messages: [],
      queued: [{ id: 'msg_q', role: 'user', parts: [{ type: 'text', text: 'Later' }] }],
    });

    expect(await adapter.loadManifest({ signal: new AbortController().signal })).toBe(manifest);
  });

  it('exports a chat with its subagent sessions as <slug>.json', async () => {
    const fake = fakeEngine();
    const saved: { name: string; lines: readonly string[] }[] = [];

    fake.sessions.set('ses_1', { ...fake.sessions.get('ses_1')!, title: 'Fix DNS' });
    fake.sessions.set('ses_c', { ...fake.sessions.get('ses_1')!, id: 'ses_c', parentID: 'ses_1' });
    fake.sessions.set('ses_2', { ...fake.sessions.get('ses_1')!, id: 'ses_2' });

    const adapter = createChatAdapter({
      engine: fake.engine,
      chat: openChat(),
      manifest,
      save: (name, lines) => void saved.push({ name, lines }),
    });

    await adapter.exportChat?.('ses_1');

    const [file] = saved;
    const parsed = JSON.parse(file?.lines.join('\n') ?? '') as {
      sidekickExport: number;
      sessions: { info: { id: string }; events?: unknown }[];
    };

    expect(file?.name).toBe('fix-dns.json');
    expect(parsed.sidekickExport).toBe(1);
    expect(parsed.sessions.map(({ info }) => info.id)).toEqual(['ses_1', 'ses_c']);
    expect(parsed.sessions[0]).not.toHaveProperty('events');
    await expect(adapter.exportChat?.('ses_gone')).rejects.toThrow('no longer exists');
  });
});
