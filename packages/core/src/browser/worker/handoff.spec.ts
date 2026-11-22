import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { batchTool } from '../../tool/batch';
import { createToolCaller } from '../../tool/bridge';
import { createKeyedLock } from '../../tool/lock';
import { ToolError } from '../../tool/tool';
import { fakePage, fakeTabs, later, type Log } from './fakes';
import { createHandoffs, HANDOFF_HEARTBEAT, HANDOFF_TIMEOUT } from './handoff';
import { callerOf, drain, OUTSIDE_TAB, setupBrowser, START_TAB } from './harness';
import { createBrowserWorker } from './serve';
import type { HandoffCard } from './types';

function setup() {
  const log: Log = [];
  const cards: { tabId: number; card: HandoffCard | null }[] = [];
  const page = fakePage(log, {
    handoff: later((tabId: number, card: HandoffCard | null) => void cards.push({ tabId, card })),
  });

  const tabs = fakeTabs(log, [START_TAB, OUTSIDE_TAB]);
  const handoffs = createHandoffs({ tabs, page });
  const controller = new AbortController();
  const wait = (tabId = 1, timeout = HANDOFF_TIMEOUT, signal = controller.signal) =>
    handoffs.wait({ tabId, message: 'Sign in', timeout, signal, sessionID: 'chat-1' });

  return { handoffs, tabs, cards, controller, wait };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the handoff registry (sidekick-13 req. 3, 7, 9)', () => {
  it('shows the card and WAIT, resolves on Continue, then removes both', async () => {
    const { handoffs, tabs, cards, wait } = setup();
    const asked = vi.fn();

    handoffs.onAsked(asked);

    const result = wait();
    const [ask] = handoffs.list();

    await flush();

    expect(ask).toMatchObject({ message: 'Sign in', tabId: 1, sessionID: 'chat-1' });
    expect(asked).toHaveBeenCalledWith(ask);
    expect(cards).toEqual([{ tabId: 1, card: { id: ask?.id, message: 'Sign in' } }]);
    expect(tabs.badges.get(1)).toBe('WAIT');

    expect(handoffs.resolve(ask?.id ?? '')).toBe(true);
    await expect(result).resolves.toEqual({ status: 'resolved' });

    await flush();

    expect(cards.at(-1)).toEqual({ tabId: 1, card: null });
    expect(tabs.badges.get(1)).toBe('');
    expect(handoffs.list()).toEqual([]);
  });

  it('times out after its deadline, and clears the card and badge', async () => {
    const { handoffs, tabs, cards, wait } = setup();
    const result = wait(1, 60_000);

    await vi.advanceTimersByTimeAsync(59_999);

    expect(handoffs.pending(1)).toBeDefined();

    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ status: 'timeout' });

    expect(cards.at(-1)).toEqual({ tabId: 1, card: null });
    expect(tabs.badges.get(1)).toBe('');
  });

  it('ends as cancelled when the run stops', async () => {
    const { controller, handoffs, wait } = setup();
    const result = wait();

    controller.abort();

    await expect(result).resolves.toEqual({ status: 'cancelled', reason: 'stopped' });
    expect(handoffs.list()).toEqual([]);
  });

  it('ends as cancelled when the tab closes', async () => {
    const { tabs, wait } = setup();
    const result = wait();

    tabs.remove(1);

    await expect(result).resolves.toEqual({ status: 'cancelled', reason: 'tab_closed' });
  });

  it('ends the first handoff on a tab as timeout when a second one starts, and keeps the second', async () => {
    const { handoffs, tabs, wait } = setup();
    const first = wait();
    const second = wait();

    await expect(first).resolves.toEqual({ status: 'timeout' });

    await flush();

    const [ask] = handoffs.list();

    expect(handoffs.list()).toHaveLength(1);
    expect(tabs.badges.get(1)).toBe('WAIT');

    handoffs.resolve(ask?.id ?? '');

    await expect(second).resolves.toEqual({ status: 'resolved' });
  });

  it('keeps handoffs on different tabs apart, and refuses Continue from another tab', async () => {
    const { handoffs, wait } = setup();
    const one = wait(1);

    void wait(2);

    const ask = handoffs.pending(1);

    expect(handoffs.list()).toHaveLength(2);
    expect(handoffs.resolve(ask?.id ?? '', 2)).toBe(false);
    expect(handoffs.resolve('unknown')).toBe(false);
    expect(handoffs.resolve(ask?.id ?? '', 1)).toBe(true);
    await expect(one).resolves.toEqual({ status: 'resolved' });
    expect(handoffs.pending(2)).toBeDefined();
  });

  it('sets WAIT again after each navigation, which clears a tab’s badge', async () => {
    const { tabs, wait } = setup();

    void wait();
    await flush();
    tabs.badges.set(1, '');
    tabs.commit({ tabId: 1 });
    await flush();

    expect(tabs.badges.get(1)).toBe('WAIT');
  });
});

describe('the handoff tool', () => {
  it('takes no permission, brings the tab forward and returns resolved on Continue', async () => {
    const { tool, ctx, runtime, tabs } = await setupBrowser();
    const handoff = tool('handoff');

    expect(handoff.permission).toBe('handoff');
    expect(handoff.lock).toBeUndefined();

    tabs.tabs.set(1, { ...START_TAB, active: false, groupId: tabs.tabs.get(1)?.groupId ?? -1 });

    const result = handoff.execute({ tab_id: 1, message: 'Sign in' }, ctx);

    await vi.waitFor(() => expect(runtime.env.handoffs.pending(1)).toBeDefined());

    expect(tabs.tabs.get(1)?.active).toBe(true);

    runtime.env.handoffs.resolve(runtime.env.handoffs.pending(1)?.id ?? '');

    await expect(result).resolves.toEqual({ output: { status: 'resolved' } });
    expect(ctx.asserts).toEqual([]);
  });

  it('refuses a tab outside the run', async () => {
    const { tool, ctx, runtime } = await setupBrowser();
    const error = await tool('handoff')
      .execute({ tab_id: 2, message: 'Sign in' }, ctx)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'not_in_group' });
    expect(runtime.env.handoffs.list()).toEqual([]);
  });

  it('caps timeout_ms at ten minutes and refuses an empty message', async () => {
    const { tool } = await setupBrowser();
    const { input } = tool('handoff');

    expect(input.safeParse({ tab_id: 1, message: 'Sign in', timeout_ms: 600_000 }).success).toBe(
      true,
    );

    expect(input.safeParse({ tab_id: 1, message: 'Sign in', timeout_ms: 600_001 }).success).toBe(
      false,
    );

    expect(input.safeParse({ tab_id: 1, message: '  ' }).success).toBe(false);
  });

  it('returns cancelled when the run stops while it waits', async () => {
    const { tool, ctx, runtime, run } = await setupBrowser();
    const result = tool('handoff').execute({ tab_id: 1, message: 'Sign in' }, ctx);

    await vi.waitFor(() => expect(runtime.env.handoffs.pending(1)).toBeDefined());
    runtime.env.runs.stop(run.id);

    await expect(result).resolves.toEqual({
      output: { status: 'cancelled', reason: 'stopped' },
    });
  });
});

describe('handoffs through the tool caller', () => {
  async function caller() {
    const setup = await setupBrowser();
    const byId = new Map(setup.runtime.tools.map((tool) => [tool.id, tool]));
    const tools = createToolCaller({
      tools: { get: (id) => byId.get(id), list: () => [...byId.values()] },
      permission: {
        assert: () => Promise.resolve(),
        reply: () => Promise.resolve(),
        list: () => [],
        cancel: () => undefined,
      },
    });

    const call = (callID: string, tool: string, input: Record<string, unknown>) =>
      tools.call(
        { sessionID: 's', messageID: 'm', callID, agent: 'build', tool, input },
        { run: () => Promise.resolve({ id: setup.run.id }) },
      );

    return { ...setup, call };
  }

  it('ends the first handoff on a tab as timeout when a second one is called (req. 7)', async () => {
    const { runtime, call } = await caller();
    const { handoffs } = runtime.env;
    const first = call('first', 'handoff', { tab_id: 1, message: 'first' });

    await vi.waitFor(() => expect(handoffs.pending(1)?.message).toBe('first'));

    const second = call('second', 'handoff', { tab_id: 1, message: 'second' });

    await expect(first).resolves.toEqual({ ok: { output: { status: 'timeout' } } });

    await vi.waitFor(() => expect(handoffs.pending(1)?.message).toBe('second'));

    handoffs.resolve(handoffs.pending(1)?.id ?? '');

    await expect(second).resolves.toEqual({ ok: { output: { status: 'resolved' } } });
  });

  it('serves no snapshot of the tab until the handoff ends, even one called with it (req. 6)', async () => {
    const { runtime, call, log } = await caller();
    const { handoffs } = runtime.env;
    const handoff = call('hand', 'handoff', { tab_id: 1, message: 'Sign in' });
    const snapshot = call('snap', 'snapshot', { tab_id: 1 });

    await vi.waitFor(() => expect(handoffs.pending(1)).toBeDefined());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(log).not.toContain('page.snapshot');

    handoffs.resolve(handoffs.pending(1)?.id ?? '');
    await handoff;
    await drain(snapshot);

    expect(log).toContain('page.snapshot');
  });

  it('keeps a waiting snapshot waiting when a second handoff replaces the first (req. 6)', async () => {
    const { runtime, call, log } = await caller();
    const { handoffs } = runtime.env;

    void call('a', 'handoff', { tab_id: 1, message: 'first' });
    await vi.waitFor(() => expect(handoffs.pending(1)?.message).toBe('first'));

    const snapshot = call('snap', 'snapshot', { tab_id: 1 });

    await vi.advanceTimersByTimeAsync(1_000);

    const second = call('b', 'handoff', { tab_id: 1, message: 'second' });

    await vi.waitFor(() => expect(handoffs.pending(1)?.message).toBe('second'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(log).not.toContain('page.snapshot');

    handoffs.resolve(handoffs.pending(1)?.id ?? '');
    await second;
    await drain(snapshot);

    expect(log).toContain('page.snapshot');
  });
});

describe('Continue through the worker', () => {
  it('accepts it from the tab’s top frame only, and tells the panel when a handoff starts and ends', async () => {
    const { runtime } = await setupBrowser();
    const worker = createBrowserWorker(runtime);
    const emitted: { type: string; data: unknown }[] = [];

    worker.connect({ emit: (type, data) => void emitted.push({ type, data }) });

    const result = runtime.env.handoffs.wait({
      tabId: 1,
      message: 'Sign in',
      timeout: HANDOFF_TIMEOUT,
      signal: new AbortController().signal,
    });

    const id = runtime.env.handoffs.pending(1)?.id ?? '';

    expect(await worker.content({ tabId: 1, frameId: 0 })['indicator.state']({})).toMatchObject({
      handoff: { id, message: 'Sign in' },
    });

    expect(
      await worker.content({ tabId: 1, frameId: 3 })['indicator.state']({}),
    ).not.toHaveProperty('handoff');

    expect(worker.handlers['handoff.list']({})).toEqual([{ id, message: 'Sign in', tabId: 1 }]);

    await worker.content({ tabId: 1, frameId: 3 })['handoff.continue']({ id });
    await worker.content({ tabId: 2, frameId: 0 })['handoff.continue']({ id });

    expect(runtime.env.handoffs.pending(1)).toBeDefined();

    await worker.content({ tabId: 1, frameId: 0 })['handoff.continue']({ id });

    await expect(result).resolves.toEqual({ status: 'resolved' });

    expect(emitted.map(({ type }) => type)).toEqual(['handoff.asked', 'handoff.ended']);
  });
});

describe('the independent review of PR #52', () => {
  it('refuses handoff as a batch step, so no step acts on the tab after a timeout', async () => {
    const setup = await setupBrowser();
    const byId = new Map(setup.runtime.tools.map((tool) => [tool.id, tool]));
    const batch = batchTool({ tools: { get: (id) => byId.get(id) }, locks: createKeyedLock() });
    const calls = [
      { tool: 'handoff', input: { tab_id: 1, message: 'Confirm the payment', timeout_ms: 1_000 } },
      { tool: 'snapshot', input: { tab_id: 1 } },
    ];

    const error = await drain(batch.execute(batch.input.parse({ calls }), setup.ctx)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ code: 'invalid_target' });
    expect(setup.log).not.toContain('page.snapshot');
    expect(setup.runtime.env.handoffs.pending(1)).toBeUndefined();
  });

  it('ends a wait_for that started before the handoff, instead of returning mid-handoff (req. 6)', async () => {
    let signedIn = false;
    const setup = await setupBrowser({ page: { hasText: later(() => signedIn) } });
    const call = callerOf(setup);
    const { handoffs } = setup.runtime.env;
    const waited = call('wait_for', { tab_id: 1, text: 'Welcome back', timeout_ms: 30_000 });
    let served: unknown;

    void waited.then((outcome) => (served = outcome));
    await vi.advanceTimersByTimeAsync(500);

    void call('handoff', { tab_id: 1, message: 'Sign in' });
    await vi.waitFor(() => expect(handoffs.pending(1)).toBeDefined());

    signedIn = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(handoffs.pending(1)).toBeDefined();
    expect(served).toMatchObject({ error: { code: 'handed_off' } });
  });

  it('keeps waiting on a live tab the content script can’t reach, like a PDF (req. 3, 8)', async () => {
    const log: Log = [];
    const page = fakePage(log, {
      handoff: () =>
        Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    });

    const tabs = fakeTabs(log, [{ ...START_TAB, url: 'https://example.com/statement.pdf' }]);
    const handoffs = createHandoffs({ tabs, page });
    const result = handoffs.wait({
      tabId: 1,
      message: 'Download the statement, then Continue',
      timeout: HANDOFF_TIMEOUT,
      signal: new AbortController().signal,
    });

    let ended: unknown;

    void result.then((end) => (ended = end));
    await vi.advanceTimersByTimeAsync(HANDOFF_HEARTBEAT * 10);

    expect(ended).toBeUndefined();
    expect(handoffs.resolve(handoffs.pending(1)?.id ?? '')).toBe(true);
    await expect(result).resolves.toEqual({ status: 'resolved' });
  });
});
