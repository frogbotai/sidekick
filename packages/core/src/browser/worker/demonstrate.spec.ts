import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordedStep } from '../../protocol';
import { batchTool } from '../../tool/batch';
import { createKeyedLock } from '../../tool/lock';
import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, setupBrowser, START_TAB } from './harness';
import { demonstrateTools } from './tools/demonstrate';
import type { HandoffCard } from './types';

function step(overrides: Partial<RecordedStep>): RecordedStep {
  return {
    kind: 'click',
    frameUrl: 'https://example.com/',
    role: 'button',
    name: 'Go',
    nearby: '',
    selector: 'button#go',
    ...overrides,
  };
}

async function setup() {
  const cards: (HandoffCard | null)[] = [];
  const records: boolean[] = [];
  const browser = await setupBrowser({
    page: {
      handoff: later((_tabId: number, card: HandoffCard | null) => void cards.push(card)),
      record: later((_tabId: number, on: boolean) => void records.push(on)),
    },
  });

  const { runtime, ctx } = browser;
  const { handoffs, recordings } = runtime.env;

  const [definition] = demonstrateTools(runtime.env);

  const demonstrate = (input: Record<string, unknown> = {}) => {
    if (!definition) throw new Error('No demonstrate tool');

    return definition.execute(
      definition.input.parse({ tab_id: 1, message: 'Show me', ...input }),
      ctx,
    );
  };

  const started = () => vi.waitFor(() => expect(handoffs.pending(1)).toBeDefined());
  const resolve = () => handoffs.resolve(handoffs.pending(1)?.id ?? '');

  return { ...browser, cards, records, handoffs, recordings, demonstrate, started, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the demonstrate tool (sidekick-21 req. 1, 6, 7)', () => {
  it('records while the card says so, and returns the steps, urls and summary on Continue', async () => {
    const { tool, ctx, cards, records, recordings, tabs, demonstrate, started, resolve } =
      await setup();

    expect(tool('demonstrate').permission).toBe('handoff');

    const result = demonstrate({ message: 'Show me how you search' });

    await started();

    expect(cards.at(-1)).toMatchObject({ message: 'Show me how you search', recording: true });
    expect(recordings.recording(1)).toBe(true);

    recordings.step(1, 0, step({ kind: 'fill', role: 'searchbox', name: 'Search', value: 'r' }));
    recordings.step(1, 0, step({ kind: 'fill', role: 'searchbox', name: 'Search', value: 'red' }));

    recordings.step(
      1,
      0,
      step({
        kind: 'fill',
        role: 'textbox',
        name: 'Address',
        masked: 'street-address',
        selector: 'input#address',
      }),
    );

    recordings.step(1, 0, step({ name: 'Search' }));

    tabs.tabs.set(1, {
      ...START_TAB,
      url: 'https://example.com/results',
      groupId: tabs.tabs.get(1)?.groupId ?? -1,
    });

    tabs.commit({ tabId: 1 });
    resolve();

    const { output } = await result;

    expect(output).toMatchObject({
      status: 'resolved',
      started_url: 'https://example.com/',
      ended_url: 'https://example.com/results',
    });

    expect(output.steps.map(({ kind }) => kind)).toEqual(['fill', 'fill', 'click', 'navigation']);
    expect(output.steps[1]).toMatchObject({ masked: 'street-address' });
    expect(output.steps[1]).not.toHaveProperty('value');

    expect(output.summary).toBe(
      [
        '1. Typed "red" into "Search"',
        '2. Typed your street address into "Address"',
        '3. Clicked the "Search" button',
        '4. Went to example.com/results',
      ].join('\n'),
    );

    expect(records.at(-1)).toBe(false);
    expect(recordings.recording(1)).toBe(false);
    expect(cards.at(-1)).toBeNull();
    expect(ctx.asserts).toEqual([]);
  });

  it('says so when nothing was recorded, and stops recording on a timeout', async () => {
    const { recordings, demonstrate, started } = await setup();
    const result = demonstrate({ timeout_ms: 1_000 });

    await started();

    const { output } = await drain(result);

    expect(output).toMatchObject({
      status: 'timeout',
      steps: [],
      summary: 'The user did nothing that was recorded.',
    });

    expect(recordings.recording(1)).toBe(false);
  });

  it('notes a browser dialog the user answered, which records no step (req. 9)', async () => {
    const { cdp, recordings, demonstrate, started, resolve } = await setup();
    const result = demonstrate();

    await started();
    recordings.step(1, 0, step({ name: 'Leave' }));

    cdp.emit({
      tabId: 1,
      method: 'Page.javascriptDialogOpening',
      params: { type: 'confirm', message: 'Leave?' },
    });

    cdp.emit({ tabId: 1, method: 'Page.javascriptDialogClosed', params: {} });
    resolve();

    const { output } = await result;

    expect(output.steps).toEqual([step({ name: 'Leave' })]);

    expect(output.summary).toBe(
      '1. Clicked the "Leave" button\nA browser dialog opened during the demonstration; the user answered it, and that part wasn’t recorded.',
    );
  });

  it('gives a plain handoff that replaces a demonstration no recording line', async () => {
    const { cards, recordings, handoffs, tool, ctx, demonstrate, started } = await setup();
    const first = demonstrate();

    await started();

    const handoff = tool('handoff').execute({ tab_id: 1, message: 'Sign in' }, ctx);

    expect((await first).output.status).toBe('timeout');
    expect(recordings.recording(1)).toBe(false);

    await vi.waitFor(() => expect(handoffs.pending(1)?.message).toBe('Sign in'));

    expect(cards.at(-1)).toEqual({ id: handoffs.pending(1)?.id, message: 'Sign in' });

    handoffs.resolve(handoffs.pending(1)?.id ?? '');
    await handoff;
  });

  it('returns cancelled with the steps so far when the run stops', async () => {
    const { runtime, run, recordings, demonstrate, started } = await setup();
    const result = demonstrate();

    await started();
    recordings.step(1, 0, step({}));
    runtime.env.runs.stop(run.id);

    const { output } = await result;

    expect(output).toMatchObject({ status: 'cancelled', reason: 'stopped' });
    expect(output.steps).toEqual([step({})]);
    expect(recordings.recording(1)).toBe(false);
  });

  it('ends at the last page it saw when the tab closes', async () => {
    const { tabs, demonstrate, started } = await setup();
    const result = demonstrate();

    await started();
    tabs.commit({ tabId: 1, url: 'https://example.com/pay' });
    tabs.remove(1);

    const { output } = await result;

    expect(output).toMatchObject({
      status: 'cancelled',
      reason: 'tab_closed',
      ended_url: 'https://example.com/pay',
    });
  });

  it('gives a replaced demonstration its own steps, and keeps the new one recording', async () => {
    const { recordings, handoffs, demonstrate, started } = await setup();
    const first = demonstrate({ message: 'First' });

    await started();
    recordings.step(1, 0, step({ name: 'One' }));

    const second = demonstrate({ message: 'Second' });

    await vi.waitFor(() => expect(handoffs.pending(1)?.message).toBe('Second'));

    const { output } = await first;

    expect(output).toMatchObject({ status: 'timeout', steps: [step({ name: 'One' })] });
    expect(recordings.recording(1)).toBe(true);

    recordings.step(1, 0, step({ name: 'Two' }));
    handoffs.resolve(handoffs.pending(1)?.id ?? '');

    expect((await second).output.steps).toEqual([step({ name: 'Two' })]);
  });

  it('refuses a tab outside the run, and records nothing', async () => {
    const { tool, ctx, recordings } = await setup();
    const error = await tool('demonstrate')
      .execute({ tab_id: 2, message: 'Show me' }, ctx)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'not_in_group' });
    expect(recordings.recording(2)).toBe(false);
  });

  it('can’t run as a batch step', async () => {
    const { runtime, ctx, recordings } = await setup();
    const byId = new Map(runtime.tools.map((entry) => [entry.id, entry]));
    const batch = batchTool({ tools: { get: (id) => byId.get(id) }, locks: createKeyedLock() });
    const calls = [{ tool: 'demonstrate', input: { tab_id: 1, message: 'Show me' } }];

    const error = await drain(batch.execute(batch.input.parse({ calls }), ctx)).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toMatchObject({ code: 'invalid_target' });
    expect(recordings.recording(1)).toBe(false);
  });
});
