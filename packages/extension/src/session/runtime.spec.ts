import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  agentPrompts,
  agents,
  BUILTIN_COMMANDS,
  commands,
  permissionModes,
  userCommands,
} from '@frogbotai/sidekick-core';
import { installFakeChrome } from '@frogbotai/sidekick-core/testing';
import { describe, expect, it } from 'vitest';

import { openChat, registerPanelExtensions, windowChat } from '.';

const SESSION = path.resolve(import.meta.dirname, '../../../core/src/session');

describe('the session engine', () => {
  it('imports no chrome.* and nothing worker-only, so it can move out of the panel', () => {
    const sources = readdirSync(SESSION).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
    );

    expect(sources).toContain('engine.ts');

    const offending = sources.filter((file) =>
      /\bchrome\s*\.|from '\.\.\/(browser|rpc|testing)\//.test(
        readFileSync(path.join(SESSION, file), 'utf8'),
      ),
    );

    expect(offending).toEqual([]);
  });
});

describe('openChat', () => {
  it('remembers one open chat per window in chrome.storage.session', async () => {
    const fake = installFakeChrome();

    await openChat.set(1, 'ses_a');
    await openChat.set(2, 'ses_b');

    expect(await openChat.get(1)).toBe('ses_a');
    expect(await openChat.get(2)).toBe('ses_b');
    expect(fake.session.get('openChat.1')).toBe('ses_a');

    await openChat.set(1, undefined);

    expect(await openChat.get(1)).toBeUndefined();
    expect(fake.data.size).toBe(0);
  });
});

describe('windowChat', () => {
  it('starts on the stored open chat, and opening another ends the previous run', async () => {
    installFakeChrome();
    await openChat.set(7, 'ses_a');

    const closed: string[] = [];
    const chat = await windowChat(7, (sessionID) => {
      closed.push(sessionID);

      return Promise.resolve();
    });

    expect(chat.current()).toBe('ses_a');

    await chat.open('ses_a');
    await chat.open('ses_b');

    expect(closed).toEqual(['ses_a']);
    expect(await openChat.get(7)).toBe('ses_b');

    await chat.open(undefined);

    expect(closed).toEqual(['ses_a', 'ses_b']);
    expect(await openChat.get(7)).toBeUndefined();
  });
});

describe('registerPanelExtensions', () => {
  it('registers built-in commands, then user commands, then prompt overrides after the built-in agents', async () => {
    installFakeChrome();
    await userCommands.set([{ name: 'sum', template: 'Summarize $1' }]);
    await agentPrompts.set({ build: 'Answer in French.', compaction: 'Summarize in French.' });

    const dispose = registerPanelExtensions();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.list().map(({ id }) => id)).toEqual([
      ...BUILTIN_COMMANDS.map(({ id }) => id),
      'sum',
    ]);

    expect(agents.list().map(({ id }) => id)).toEqual(['build', 'explore', 'title', 'compaction']);
    expect(agents.get('build')?.system).toBe('Answer in French.');
    expect(agents.get('compaction')?.system).toBe('Summarize in French.');
    expect(permissionModes.list().length).toBeGreaterThan(0);

    dispose();

    expect(commands.list()).toEqual([]);
    expect(agents.list()).toEqual([]);
  });
});
