import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { createForms, type Forms } from '../form';
import { createPermissionEngine } from '../permission/engine';
import { BUILTIN_MODES, type PermissionMode } from '../permission/modes';
import { searchProviders, tools } from '../registry';
import { createRegistry } from '../registry/registry';
import { permissionGrants, webSearchProvider } from '../storage';
import { installFakeChrome } from '../testing/fakeChrome';
import { type ToolContext, ToolError } from '../tool/tool';
import { SearchHttpError } from './http';
import type { SearchProvider } from './registry';
import { MAX_CONTENT_CHARS, webSearch } from './service';
import {
  CHOICE_TIMEOUT_MS,
  NO_RESULTS,
  registerWebSearchTool,
  WEB_SEARCH_TOOL,
  webSearchTool,
} from './tool';

const RESULTS = [
  { url: 'https://a.example/', title: 'A', content: 'About A' },
  { url: 'https://b.example/' },
];

let forms: Forms;
let disposers: (() => void)[] = [];
let search: ReturnType<typeof vi.fn<SearchProvider['search']>>;

function provide(id = 'frogbot', name = 'FrogBot') {
  const provider: SearchProvider = { id, name, search };

  disposers.push(searchProviders.register(id, (draft) => draft.add(provider)));
}

function context(): ToolContext & { asserts: unknown[] } {
  const asserts: unknown[] = [];

  return {
    asserts,
    signal: new AbortController().signal,
    session: { id: 'session-1' },
    messageID: 'message-1',
    callID: 'call-1',
    agent: 'build',
    permission: { assert: (request) => Promise.resolve(void asserts.push(request)) },
  };
}

function run(query = 'chrome mv3') {
  return webSearchTool(forms).execute({ query }, context());
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ToolError);

  return error as ToolError;
}

async function nextForm() {
  await vi.waitFor(() => expect(forms.pending()).not.toHaveLength(0));

  const [form] = forms.pending();

  if (!form) throw new Error('No form');

  return form;
}

async function answer(key: string, value: string) {
  const form = await nextForm();

  expect(forms.reply(form.id, { [key]: value })).toBe(true);

  return form;
}

beforeEach(() => {
  installFakeChrome();
  forms = createForms();
  search = vi.fn<SearchProvider['search']>(() => Promise.resolve(RESULTS));
  disposers = [];
});

afterEach(() => {
  for (const dispose of disposers) dispose();

  vi.useRealTimers();
});

describe('web_search output', () => {
  beforeEach(async () => {
    provide();
    await webSearch.select('frogbot');
  });

  it('returns the provider and results, as markdown for the model', async () => {
    const ctx = context();
    const result = await webSearchTool(forms).execute({ query: 'chrome mv3' }, ctx);

    expect(search).toHaveBeenCalledWith('chrome mv3', ctx.signal);
    expect(ctx.asserts).toEqual([{ action: 'websearch', resource: 'chrome mv3' }]);
    expect(result.output).toEqual({ provider: 'frogbot', results: RESULTS });

    expect(result.content).toEqual([
      {
        type: 'text',
        text: '## [A](https://a.example/)\n\nAbout A\n\n## [https://b.example/](https://b.example/)',
      },
    ]);
  });

  it('says so when nothing was found', async () => {
    search.mockResolvedValue([]);

    expect((await run()).content).toEqual([{ type: 'text', text: NO_RESULTS }]);
  });

  it('cuts each result’s content to 4,000 characters', async () => {
    search.mockResolvedValue([{ url: 'https://a.example/', content: 'x'.repeat(5_000) }]);

    expect((await run()).output.results[0]?.content).toHaveLength(MAX_CONTENT_CHARS);
  });

  it('refuses results of the wrong shape', async () => {
    search.mockResolvedValue([{ title: 'no url' } as never]);

    expect(await failure(run())).toMatchObject({ code: 'request_failed' });
  });

  it('passes a provider’s tool errors on as they are', async () => {
    search.mockRejectedValue(
      new ToolError('reconnect', 'FrogBot refused the key. Reconnect FrogBot.'),
    );

    expect(await failure(run())).toMatchObject({ code: 'reconnect', message: /Reconnect/ });
  });

  it('prints each result’s published time', async () => {
    search.mockResolvedValue([
      {
        url: 'https://a.example/',
        title: 'A',
        content: 'About A',
        published: Date.UTC(2026, 6, 25),
      },
    ]);

    expect((await run()).content).toEqual([
      {
        type: 'text',
        text: '## [A](https://a.example/)\nPublished: 2026-07-25T00:00:00.000Z\n\nAbout A',
      },
    ]);
  });

  it('says what an HTTP failure was, with no URL', async () => {
    for (const [status, code, message] of [
      [429, 'rate_limited', 'Web search rate limited (HTTP 429)'],
      [401, 'request_failed', 'Web search authentication failed (HTTP 401)'],
      [503, 'request_failed', 'Web search request failed (HTTP 503)'],
    ] as const) {
      search.mockRejectedValue(new SearchHttpError(status));

      expect(await failure(run())).toMatchObject({ code, message });
    }
  });

  it('searches for the tool call’s session', async () => {
    const query = vi.spyOn(webSearch, 'query');
    const ctx = context();

    await webSearchTool(forms).execute({ query: 'q' }, ctx);

    expect(query).toHaveBeenCalledWith('q', ctx.signal, 'session-1');

    query.mockRestore();
  });
});

describe('the first-use prompt', () => {
  beforeEach(() => provide());

  it('asks, and "Allow search via FrogBot" stores random', async () => {
    const pending = run();
    const form = await answer('choice', 'allow');

    expect(form).toMatchObject({
      title: 'Web Search',
      fields: [
        {
          key: 'choice',
          description: 'Allow Sidekick to search the web for up-to-date information?',
          options: [
            { value: 'allow', label: 'Allow search via FrogBot' },
            { value: 'choose', label: 'Choose another provider' },
            { value: 'disable', label: 'Disable web search' },
          ],
        },
      ],
    });

    expect((await pending).output.provider).toBe('frogbot');
    expect(await webSearchProvider.get()).toBe('random');

    expect(await permissionGrants.get()).toEqual([
      { action: 'websearch', resource: '*', created: expect.any(Number) },
    ]);
  });

  it('is the only card on a first search: the engine never asks for websearch', async () => {
    const agents = createRegistry<AgentInfo>('agents');
    const modes = createRegistry<PermissionMode>('permissionModes');
    const asked: unknown[] = [];

    agents.register('test', (draft) => {
      for (const agent of BUILTIN_AGENTS) draft.add(agent);
    });

    modes.register('test', (draft) => {
      for (const mode of BUILTIN_MODES) draft.add(mode);
    });

    const engine = createPermissionEngine({
      agents,
      modes,
      emit: (type, data) => void asked.push({ type, data }),
    });

    const ctx = context();
    const scope = {
      sessionID: 'session-1',
      messageID: 'message-1',
      callID: 'call-1',
      agent: 'build',
    };

    const pending = webSearchTool(forms).execute(
      { query: 'chrome mv3' },
      {
        ...ctx,
        permission: { assert: (request) => engine.assert(request, { ...scope, mode: 'plan' }) },
      },
    );

    await answer('choice', 'allow');

    expect((await pending).output.provider).toBe('frogbot');
    expect(forms.pending()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('"Choose another provider" lists the providers and stores the pick', async () => {
    const pending = run();

    await answer('choice', 'choose');

    const second = await answer('provider', 'frogbot');

    expect(second.fields[0]?.options).toEqual([{ value: 'frogbot', label: 'FrogBot' }]);
    expect((await pending).output.provider).toBe('frogbot');
    expect(await webSearchProvider.get()).toBe('frogbot');

    expect(
      (await permissionGrants.get()).map(({ action, resource }) => `${action} ${resource}`),
    ).toEqual(['websearch *']);
  });

  it('"Disable web search" stores false, fails the call and removes the tool', async () => {
    const undo = registerWebSearchTool(forms);

    disposers.push(undo);
    await undo.ready;

    expect(tools.get(WEB_SEARCH_TOOL)).toBeDefined();

    const pending = run();

    await answer('choice', 'disable');

    expect(await failure(pending)).toMatchObject({ code: 'search_disabled' });
    expect(await webSearchProvider.get()).toBe(false);
    expect(await permissionGrants.get()).toEqual([]);
    expect(search).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(tools.get(WEB_SEARCH_TOOL)).toBeUndefined());
  });

  it('cancel stores nothing and fails "Web search cancelled"', async () => {
    const pending = run();
    const form = await nextForm();

    forms.cancel(form.id);

    expect(await failure(pending)).toMatchObject({
      code: 'cancelled',
      message: 'Web search cancelled',
    });

    expect(await webSearchProvider.get()).toBeUndefined();
  });

  it('cancelling the second form stores nothing', async () => {
    const pending = run();

    await answer('choice', 'choose');
    forms.cancel((await nextForm()).id);

    expect(await failure(pending)).toMatchObject({ code: 'cancelled' });
    expect(await webSearchProvider.get()).toBeUndefined();
  });

  it('gives up after a minute unanswered, storing nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const pending = run();

    await nextForm();
    vi.advanceTimersByTime(CHOICE_TIMEOUT_MS);

    expect(await failure(pending)).toMatchObject({ message: 'Web search cancelled' });
    expect(forms.pending()).toEqual([]);
    expect(await webSearchProvider.get()).toBeUndefined();
  });

  it('shows one prompt for two calls at once', async () => {
    const first = run('one');
    const second = run('two');

    await answer('choice', 'allow');

    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(forms.pending()).toEqual([]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps a stored frogbot choice across a reconnect, without asking', async () => {
    await webSearch.select('frogbot');

    for (const dispose of disposers) dispose();

    disposers = [];
    provide();

    await expect(run()).resolves.toMatchObject({ output: { provider: 'frogbot' } });
    expect(forms.pending()).toEqual([]);
  });

  it('asks again when the stored choice names no registered provider', async () => {
    await webSearch.select('exa');

    const pending = run();

    await answer('choice', 'allow');

    await expect(pending).resolves.toBeDefined();
  });

  it('asks again when the stored value is unreadable', async () => {
    await chrome.storage.local.set({ 'websearch:provider': 42 });

    const pending = run();

    await answer('choice', 'allow');

    await expect(pending).resolves.toBeDefined();
  });
});

describe('registerWebSearchTool', () => {
  it('offers no web_search while no search provider is registered, and adds it on connect', async () => {
    const undo = registerWebSearchTool(forms);

    disposers.push(undo);
    await undo.ready;

    expect(tools.get(WEB_SEARCH_TOOL)).toBeUndefined();

    provide();

    await vi.waitFor(() => expect(tools.get(WEB_SEARCH_TOOL)).toBeDefined());

    expect(tools.errors()).toEqual([]);
  });

  it('offers no web_search while search is disabled', async () => {
    provide();
    await webSearch.select(false);

    const undo = registerWebSearchTool(forms);

    disposers.push(undo);
    await undo.ready;

    expect(tools.get(WEB_SEARCH_TOOL)).toBeUndefined();
    expect(await failure(run())).toMatchObject({ code: 'search_disabled' });
  });
});
