import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLAN_MODE } from '../permission/modes';
import { commands } from '../registry';
import { userCommands } from '../storage/items';
import { installFakeChrome } from '../testing/fakeChrome';
import { BUILTIN_COMMANDS, registerBuiltinCommands } from './builtin';
import { type CommandContext, toComposerCommand } from './command';
import { commandNameError, registerUserCommands } from './user';

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function context(sessionID?: string) {
  const ui = {
    newChat: vi.fn(),
    openView: vi.fn(),
    pickModel: vi.fn(),
    setMode: vi.fn(),
    openOptions: vi.fn(),
    open: vi.fn(() => Promise.resolve(sessionID ?? 'ses_new')),
  };

  const engine = {
    prompt: vi.fn(() => Promise.resolve({ messageID: 'msg_1', done: Promise.resolve() })),
    compact: vi.fn(() => Promise.resolve({ status: 'completed' as const })),
  };

  const ctx = { sessionID, ui, engine } as unknown as CommandContext;

  return { ctx, ui, engine };
}

function composer(id: string, ctx: CommandContext) {
  const info = commands.get(id);

  if (!info) throw new Error(`No /${id}`);

  return toComposerCommand(info, ctx);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('built-in commands', () => {
  it('register as builtin, in menu order', () => {
    disposers.push(registerBuiltinCommands());

    expect(commands.list().map(({ id }) => id)).toEqual([
      'new',
      'connect',
      'model',
      'compact',
      'plan',
      'permissions',
      'help',
    ]);

    disposers.pop()?.();

    expect(commands.list()).toEqual([]);
  });

  it('run their panel actions, and only /model takes arguments', async () => {
    disposers.push(registerBuiltinCommands());

    const { ctx, ui, engine } = context('ses_1');

    expect(BUILTIN_COMMANDS.filter((info) => info.arguments).map(({ id }) => id)).toEqual([
      'model',
    ]);

    await composer('new', ctx).execute('');
    await composer('connect', ctx).execute('');
    await composer('model', ctx).execute('sonnet');
    await composer('model', ctx).execute('');
    await composer('plan', ctx).execute('');
    await composer('permissions', ctx).execute('');
    await composer('help', ctx).execute('');
    await composer('compact', ctx).execute('');

    expect(ui.newChat).toHaveBeenCalledOnce();
    expect(ui.openView.mock.calls).toEqual([['providers'], ['help']]);
    expect(ui.pickModel.mock.calls).toEqual([['sonnet'], [undefined]]);
    expect(ui.setMode).toHaveBeenCalledWith(PLAN_MODE);
    expect(ui.openOptions).toHaveBeenCalledWith('permissions');
    expect(engine.compact).toHaveBeenCalledWith({ sessionID: 'ses_1' });
  });

  it('disables /compact with no open chat, and rejects when compaction fails', async () => {
    disposers.push(registerBuiltinCommands());

    expect(composer('compact', context().ctx).disabled).toBe(true);
    expect(composer('new', context().ctx).disabled).toBe(false);

    const { ctx, engine } = context('ses_1');

    engine.compact.mockResolvedValueOnce({
      status: 'failed',
      error: { type: 'compaction', message: 'Nothing to compact yet.' },
    } as never);

    await expect(composer('compact', ctx).execute('')).rejects.toThrow('Nothing to compact yet.');
  });

  it('maps a command for the composer, with a throwing one rejecting', async () => {
    const dispose = commands.register('test', (draft) =>
      draft.add({
        id: 'broken',
        title: 'Broken',
        description: 'Always fails',
        execute: () => {
          throw new Error('boom');
        },
      }),
    );

    disposers.push(dispose);

    const mapped = composer('broken', context('ses_1').ctx);

    expect(mapped).toMatchObject({
      id: 'broken',
      title: 'Broken',
      description: 'Always fails',
      disabled: false,
    });

    expect(mapped.arguments).toBeUndefined();
    await expect(Promise.resolve().then(() => mapped.execute(''))).rejects.toThrow('boom');
  });
});

describe('user commands', () => {
  it('register as user after the built-ins, and re-register when the item changes', async () => {
    installFakeChrome();
    await userCommands.set([{ name: 'sum', description: 'Summarize', template: 'Summarize $1' }]);

    disposers.push(registerBuiltinCommands(), registerUserCommands());
    await flush();

    expect(commands.list().map(({ id }) => id)).toEqual([
      ...BUILTIN_COMMANDS.map(({ id }) => id),
      'sum',
    ]);

    expect(commands.get('sum')).toMatchObject({ title: 'Summarize', arguments: true });

    await userCommands.set([{ name: 'review/pr', template: 'Review $ARGUMENTS' }]);

    expect(commands.get('sum')).toBeUndefined();
    expect(commands.get('review/pr')).toMatchObject({ title: 'review/pr', arguments: true });
  });

  it('prompt the open chat with the expanded text, on the template model', async () => {
    installFakeChrome();

    await userCommands.set([
      { name: 'sum', template: 'First $1. Rest $2.', model: 'openai/gpt-6-luna' },
      { name: 'plain', template: 'Explain.' },
    ]);

    disposers.push(registerUserCommands());
    await flush();

    const { ctx, ui, engine } = context();

    await composer('sum', ctx).execute('"alpha beta" gamma delta');
    await composer('plain', ctx).execute('');

    expect(ui.open).toHaveBeenCalledTimes(2);

    expect(engine.prompt.mock.calls).toEqual([
      [
        {
          sessionID: 'ses_new',
          parts: [{ type: 'text', text: 'First alpha beta. Rest gamma delta.' }],
          model: 'openai/gpt-6-luna',
        },
      ],
      [{ sessionID: 'ses_new', parts: [{ type: 'text', text: 'Explain.' }] }],
    ]);
  });

  it('queue mid-reply, and settle only once their turn ends', async () => {
    installFakeChrome();
    await userCommands.set([{ name: 'sum', template: 'Summarize' }]);
    disposers.push(registerBuiltinCommands(), registerUserCommands());
    await flush();

    const { ctx, engine } = context('ses_1');
    let end = () => {};

    const done = new Promise<void>((resolve) => {
      end = resolve;
    });

    engine.prompt.mockResolvedValueOnce({ messageID: 'msg_1', done });

    const sum = composer('sum', ctx);
    let settled = false;
    const ran = Promise.resolve(sum.execute('')).then(() => {
      settled = true;
    });

    await flush();

    expect(sum.queue).toBe(true);
    expect(composer('compact', ctx).queue).toBeUndefined();
    expect(engine.prompt).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    end();
    await ran;

    expect(settled).toBe(true);
  });

  it('skip a template named after a built-in, list it in errors(), and keep the rest', async () => {
    installFakeChrome();
    disposers.push(registerBuiltinCommands(), registerUserCommands());

    await userCommands.set([
      { name: 'new', template: 'Not a new chat' },
      { name: 'sum', template: 'Summarize' },
    ]);

    expect(commands.get('new')?.title).toBe('New chat');
    expect(commands.get('sum')).toBeDefined();

    expect(commands.errors()).toEqual([
      { source: 'user', error: new Error('/new is already registered.') },
    ]);
  });

  it('refuse bad and duplicate names in the schema, and explain each in the form', async () => {
    installFakeChrome();

    await expect(userCommands.set([{ name: 'has space', template: 'x' }])).rejects.toThrow();
    await expect(userCommands.set([{ name: '/lead', template: 'x' }])).rejects.toThrow();

    await expect(
      userCommands.set([
        { name: 'a', template: 'x' },
        { name: 'a', template: 'y' },
      ]),
    ).rejects.toThrow();

    expect(commandNameError('', [])).toBe('Enter a name.');
    expect(commandNameError('has space', [])).toBe('Use letters, digits, -, _ and /.');
    expect(commandNameError('new', [])).toBe('/new is already a built-in.');
    expect(commandNameError('sum', ['sum'])).toBe('/sum already exists.');
    expect(commandNameError('review/pr', ['sum'])).toBeUndefined();
  });
});
