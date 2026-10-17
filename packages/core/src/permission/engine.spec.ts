import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInfo } from '../agent/agent';
import { BUILTIN_AGENTS } from '../agent/builtin';
import { createRegistry } from '../registry/registry';
import { blockedSites, permissionGrants, permissionUsage } from '../storage/items';
import { installFakeChrome } from '../testing/fakeChrome';
import type { PermissionRequest } from '../tool/tool';
import { ToolError } from '../tool/tool';
import { createPermissionEngine, type PermissionScope, USAGE_INTERVAL } from './engine';
import { BUILTIN_MODES, type PermissionMode } from './modes';

const EXPLORE: AgentInfo = {
  id: 'explore',
  name: 'Explore',
  mode: 'subagent',
  hidden: false,
  permissions: [{ action: '*', resource: '*', effect: 'allow' }],
};

const NO_INPUT: AgentInfo = {
  ...EXPLORE,
  id: 'reader',
  name: 'Reader',
  permissions: [{ action: 'input', resource: '*', effect: 'deny' }],
};

function setup() {
  const agents = createRegistry<AgentInfo>('agents');
  const modes = createRegistry<PermissionMode>('permissionModes');
  const events: { type: string; data: unknown }[] = [];
  let clock = 1_000;

  agents.register('builtin', (draft) => {
    for (const agent of [...BUILTIN_AGENTS, EXPLORE, NO_INPUT]) draft.add(agent);
  });

  modes.register('builtin', (draft) => {
    for (const mode of BUILTIN_MODES) draft.add(mode);
  });

  const engine = createPermissionEngine({
    agents,
    modes,
    emit: (type, data) => void events.push({ type, data }),
    now: () => clock,
  });

  return {
    engine,
    events,
    asked: () => engine.list(),
    tick: (ms: number) => (clock += ms),
  };
}

function scope(overrides: Partial<PermissionScope> = {}): PermissionScope {
  return {
    sessionID: 'ses-1',
    messageID: 'msg-1',
    callID: 'call-1',
    agent: 'build',
    sites: ['shop.example'],
    ...overrides,
  };
}

function input(resource: string, frameOrigin?: string): PermissionRequest {
  return { action: 'input', resource, ...(frameOrigin ? { frameOrigin } : {}) };
}

async function flush() {
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
}

async function outcome(promise: Promise<void>) {
  return promise.then(
    () => 'allowed',
    (error: unknown) => (error instanceof ToolError ? error.code : String(error)),
  );
}

async function pending(promise: Promise<void>) {
  let settled = false;

  promise.then(
    () => (settled = true),
    () => (settled = true),
  );

  await flush();

  return !settled;
}

beforeEach(() => {
  installFakeChrome();
});

describe('the permission engine', () => {
  it('lets Build read, navigate and switch tabs anywhere, and act unasked on the chat’s sites', async () => {
    const { engine, asked } = setup();

    await engine.assert({ action: 'read', resource: 'https://github.com' }, scope());
    await engine.assert({ action: 'navigate', resource: 'https://github.com' }, scope());
    await engine.assert({ action: 'tabs', resource: '*' }, scope());
    await engine.assert({ action: 'websearch', resource: 'chrome mv3' }, scope());
    await engine.assert(input('https://www.shop.example'), scope());

    expect(asked()).toEqual([]);
  });

  it('asks before input elsewhere, and after Always no chat asks there', async () => {
    const { engine, asked } = setup();
    const first = engine.assert(input('https://github.com'), scope());

    expect(await pending(first)).toBe(true);

    expect(asked()).toEqual([
      expect.objectContaining({
        sessionID: 'ses-1',
        action: 'input',
        site: 'github.com',
        always: true,
      }),
    ]);

    await engine.reply({ id: asked()[0]?.id ?? '', reply: 'always' });

    expect(await outcome(first)).toBe('allowed');

    expect(await permissionGrants.get()).toEqual([
      { action: 'input', resource: 'github.com', created: 1_000 },
    ]);

    await engine.assert(input('https://github.com'), scope({ sessionID: 'ses-2', callID: 'c2' }));

    expect(asked()).toEqual([]);
  });

  it('shares one grant between www.github.com and github.com, but not another port', async () => {
    const { engine, asked } = setup();

    await permissionGrants.set([{ action: 'input', resource: 'github.com', created: 1 }]);

    await engine.assert(input('https://www.github.com'), scope());
    await engine.assert(input('https://GitHub.com.'), scope());

    expect(asked()).toEqual([]);

    const other = engine.assert(input('https://github.com:8443'), scope());

    expect(await pending(other)).toBe(true);
    expect(asked()[0]?.site).toBe('github.com:8443');

    engine.close('ses-1');
    await outcome(other);
  });

  it('lets the last match win, asks when no rule matches, and denies an unknown agent', async () => {
    const agents = createRegistry<AgentInfo>('agents');
    const modes = createRegistry<PermissionMode>('permissionModes');

    agents.register('test', (draft) => draft.add(EXPLORE));

    modes.register('test', (draft) => {
      draft.add({
        id: 'build',
        name: 'Strict',
        rules: [
          { action: 'read', resource: '*', effect: 'deny' },
          { action: 'read', resource: 'docs.example', effect: 'allow' },
        ],
      });
    });

    const engine = createPermissionEngine({ agents, modes, emit: () => undefined });
    const explore = scope({ agent: 'explore' });

    await engine.assert({ action: 'read', resource: 'https://docs.example' }, explore);

    expect(
      await outcome(engine.assert({ action: 'read', resource: 'https://other.example' }, explore)),
    ).toBe('denied');

    expect(
      await outcome(
        engine.assert(
          { action: 'read', resource: 'https://docs.example' },
          scope({ agent: 'gone' }),
        ),
      ),
    ).toBe('denied');

    const unmatched = engine.assert(
      { action: 'navigate', resource: 'https://docs.example' },
      explore,
    );

    expect(await pending(unmatched)).toBe(true);
    expect(engine.list()).toHaveLength(1);

    engine.close('ses-1');

    expect(await outcome(unmatched)).toBe('declined');
  });

  it('puts a deny rule and a blocked site before a saved grant', async () => {
    const { engine } = setup();

    await permissionGrants.set([
      { action: 'input', resource: 'github.com', created: 1 },
      { action: 'input', resource: 'bank.example', created: 1 },
    ]);

    await blockedSites.set([{ site: 'bank.example', created: 1 }]);

    expect(await outcome(engine.assert(input('https://github.com'), scope({ mode: 'plan' })))).toBe(
      'denied',
    );

    expect(await outcome(engine.assert(input('https://login.bank.example'), scope()))).toBe(
      'denied',
    );

    expect(
      await outcome(engine.assert({ action: 'read', resource: 'https://bank.example' }, scope())),
    ).toBe('denied');

    expect(
      await outcome(engine.assert(input('https://github.com'), scope({ agent: 'reader' }))),
    ).toBe('denied');

    expect(await permissionUsage.get()).toEqual({ 'blocked bank.example': 1_000 });
  });

  it('asks without Always on a sensitive site’s subdomain, even when granted and in Auto', async () => {
    const { engine, asked } = setup();

    await permissionGrants.set([{ action: '*', resource: '*', created: 1 }]);

    const read = engine.assert(
      { action: 'read', resource: 'https://js.stripe.com' },
      scope({ mode: 'auto' }),
    );

    expect(await pending(read)).toBe(true);
    expect(asked()).toEqual([expect.objectContaining({ site: 'js.stripe.com', always: false })]);

    await engine.reply({ id: asked()[0]?.id ?? '', reply: 'always' });

    expect(await outcome(read)).toBe('allowed');
    expect(await permissionGrants.get()).toHaveLength(1);
  });

  it('treats a webfetch origin as a site: blocked denies, sensitive always asks, others run', async () => {
    const { engine, asked } = setup();
    const fetch = (resource: string) => ({ action: 'webfetch' as const, resource });

    await blockedSites.set([{ site: 'bank.example', created: 1 }]);

    expect(await outcome(engine.assert(fetch('https://bank.example'), scope()))).toBe('denied');

    expect(
      await outcome(
        engine.assert(fetch('https://developer.chrome.com'), scope({ agent: 'research' })),
      ),
    ).toBe('allowed');

    const sensitive = engine.assert(fetch('https://js.stripe.com'), scope({ mode: 'auto' }));

    expect(await pending(sensitive)).toBe(true);

    expect(asked()).toEqual([
      expect.objectContaining({ action: 'webfetch', site: 'js.stripe.com', always: false }),
    ]);
  });

  it('allows subagent in every mode, and research and explore deny it', async () => {
    const { engine } = setup();
    const dispatch = { action: 'subagent' as const, resource: 'research' };

    for (const mode of ['build', 'plan', 'auto']) {
      expect(await outcome(engine.assert(dispatch, scope({ mode })))).toBe('allowed');
    }

    expect(await outcome(engine.assert(dispatch, scope({ agent: 'research' })))).toBe('denied');
  });

  it('checks a cross-site frame on its own site, and names the page it sits in', async () => {
    const { engine, asked } = setup();
    const call = engine.assert(input('https://shop.example', 'https://js.stripe.com'), scope());

    expect(await pending(call)).toBe(true);

    expect(asked()).toEqual([
      expect.objectContaining({ site: 'js.stripe.com', inside: 'shop.example', always: false }),
    ]);

    engine.close('ses-1');
    await outcome(call);

    const frame = engine.assert(input('https://github.com', 'https://shop.example'), scope());

    expect(await outcome(frame)).toBe('allowed');
  });

  it('denies the compaction agent every action, in every mode', async () => {
    const { engine, asked } = setup();

    for (const mode of ['build', 'plan', 'auto']) {
      for (const action of ['read', 'input', 'navigate', 'tabs', 'websearch'] as const) {
        const resource = action === 'websearch' ? 'query' : 'https://shop.example';

        expect(
          await outcome(engine.assert({ action, resource }, scope({ agent: 'compaction', mode }))),
        ).toBe('denied');
      }
    }

    expect(asked()).toEqual([]);
  });

  it('never lets an agent widen Plan', async () => {
    const { engine } = setup();

    expect(
      await outcome(
        engine.assert(input('https://shop.example'), scope({ mode: 'plan', agent: 'explore' })),
      ),
    ).toBe('denied');

    await engine.assert(
      { action: 'read', resource: 'https://github.com' },
      scope({ mode: 'plan', agent: 'explore' }),
    );
  });

  it('lets Allow once cover one call, so a second call asks', async () => {
    const { engine, asked } = setup();
    const first = engine.assert(input('https://github.com'), scope());

    await flush();
    await engine.reply({ id: asked()[0]?.id ?? '', reply: 'once' });

    expect(await outcome(first)).toBe('allowed');

    await engine.assert(input('https://github.com'), scope());

    const second = engine.assert(input('https://github.com'), scope({ callID: 'call-2' }));

    expect(await pending(second)).toBe(true);
    expect(await permissionGrants.get()).toEqual([]);

    engine.cancel('call-2');

    expect(await outcome(second)).toBe('cancelled');
  });

  it('settles a waiting sibling that Always now covers, and reports each reply', async () => {
    const { engine, asked, events } = setup();
    const first = engine.assert(input('https://github.com'), scope());
    const sibling = engine.assert(input('https://github.com'), scope({ callID: 'call-2' }));
    const other = engine.assert(input('https://gitlab.com'), scope({ callID: 'call-3' }));

    await flush();

    const [ask] = asked();

    await engine.reply({ id: ask?.id ?? '', reply: 'always' });

    expect(await outcome(first)).toBe('allowed');
    expect(await outcome(sibling)).toBe('allowed');
    expect(await pending(other)).toBe(true);

    expect(events.filter(({ type }) => type === 'permission.replied')).toHaveLength(2);
    expect(events.filter(({ type }) => type === 'permission.asked')).toHaveLength(3);

    engine.close('ses-1');
    await outcome(other);
  });

  it('rejects the chat’s waiting asks declined on a plain Deny, and only that call denied with a note', async () => {
    const { engine, asked } = setup();
    const first = engine.assert(input('https://github.com'), scope());
    const sibling = engine.assert(input('https://gitlab.com'), scope({ callID: 'call-2' }));
    const elsewhere = engine.assert(input('https://gitlab.com'), scope({ sessionID: 'ses-2' }));

    await flush();
    await engine.reply({ id: asked()[0]?.id ?? '', reply: 'reject' });

    expect(await outcome(first)).toBe('declined');
    expect(await outcome(sibling)).toBe('declined');
    expect(await pending(elsewhere)).toBe(true);

    const noted = engine.assert(
      input('https://gitlab.com'),
      scope({ sessionID: 'ses-2', callID: 'call-4' }),
    );

    await flush();

    const [kept, target] = engine.list('ses-2');

    await engine.reply({ id: target?.id ?? '', reply: 'reject', message: ' Use the search box ' });

    const error = await noted.then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ToolError);

    expect(error).toMatchObject({
      code: 'denied',
      message: 'The user denied this: Use the search box',
    });

    expect(engine.list('ses-2')).toEqual([kept]);

    engine.close('ses-2');

    expect(await outcome(elsewhere)).toBe('declined');
  });

  it('waits past 31 s for a reply', async () => {
    vi.useFakeTimers();

    try {
      const { engine, asked } = setup();
      const call = engine.assert(input('https://github.com'), scope());

      await vi.advanceTimersByTimeAsync(31_000);

      expect(await pending(call)).toBe(true);

      await engine.reply({ id: asked()[0]?.id ?? '', reply: 'once' });

      expect(await outcome(call)).toBe('allowed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects waiting asks on close, cancel and abort', async () => {
    const { engine, asked, events } = setup();
    const closed = engine.assert(input('https://github.com'), scope());
    const cancelled = engine.assert(
      input('https://github.com'),
      scope({ sessionID: 'ses-2', callID: 'c2' }),
    );

    const controller = new AbortController();
    const aborted = engine.assert(
      input('https://github.com'),
      scope({ sessionID: 'ses-3', callID: 'c3' }),
      controller.signal,
    );

    await flush();

    engine.close('ses-1');
    engine.cancel('c2');
    controller.abort();

    expect(await outcome(closed)).toBe('declined');
    expect(await outcome(cancelled)).toBe('cancelled');
    expect(await outcome(aborted)).toBe('cancelled');
    expect(asked()).toEqual([]);
    expect(events.filter(({ type }) => type === 'permission.replied')).toHaveLength(3);
  });

  it('runs an MCP client’s calls unasked, sensitive sites included, but keeps blocked sites and agent denies', async () => {
    const { engine, asked } = setup();
    const client = { id: 'mcp-1', name: 'Claude Desktop' };

    await blockedSites.set([{ site: 'bank.example', created: 1 }]);

    await engine.assert(input('https://accounts.google.com'), scope({ client }));
    await engine.assert(input('https://github.com'), scope({ client, mode: 'plan' }));

    expect(asked()).toEqual([]);

    expect(await outcome(engine.assert(input('https://bank.example'), scope({ client })))).toBe(
      'denied',
    );

    expect(
      await outcome(engine.assert(input('https://github.com'), scope({ client, agent: 'reader' }))),
    ).toBe('denied');
  });

  it('writes a grant’s last use at most once a minute', async () => {
    const { engine, tick } = setup();

    await permissionGrants.set([{ action: 'input', resource: 'github.com', created: 1 }]);

    await engine.assert(input('https://github.com'), scope());
    await flush();
    tick(1_000);
    await engine.assert(input('https://github.com'), scope());
    await flush();

    expect(await permissionUsage.get()).toEqual({ 'input github.com': 1_000 });

    tick(USAGE_INTERVAL);
    await engine.assert(input('https://github.com'), scope());
    await flush();

    expect(await permissionUsage.get()).toEqual({ 'input github.com': 2_000 + USAGE_INTERVAL });
  });
});
