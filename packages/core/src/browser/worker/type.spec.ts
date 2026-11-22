import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { later } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { FOCUS_CHECK_EVERY } from './input';
import type { Focused, Page } from './types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const FIELD: Focused = {
  frameId: 0,
  frameOrigin: 'https://example.com',
  editable: true,
  role: 'textbox',
  name: 'Search',
};

const TARGET = {
  frameId: 0,
  frameOrigin: 'https://example.com',
  redacted: false,
  role: 'textbox',
  name: 'Search',
};

function setupField(page: Partial<Page> = {}) {
  return setupBrowser({
    page: { inspect: later(() => TARGET), focused: later(() => FIELD), ...page },
  });
}

function typed(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent.flatMap(({ method, params }) => {
    if (method === 'Input.insertText') return [`insert:${String(params.text)}`];

    if (method !== 'Input.dispatchKeyEvent') return [];

    return [`${String(params.type)}:${String(params.key)}:${String(params.text ?? '')}`];
  });
}

describe('type (sidekick-17 req. 1-7)', () => {
  it('presses each ASCII character and inserts anything else one grapheme at a time', async () => {
    const { tool, ctx, cdp } = await setupField();

    const { output } = await drain(
      tool('type').execute({ tab_id: 1, ref: 'f0e1', text: 'aB é👍🏽\n' }, ctx),
    );

    expect(typed(cdp.sent)).toEqual([
      'keyDown:a:a',
      'keyUp:a:',
      'keyDown:B:B',
      'keyUp:B:',
      'keyDown: : ',
      'keyUp: :',
      'insert:é',
      'insert:👍🏽',
      'keyDown:Enter:\r',
      'keyUp:Enter:',
    ]);

    expect(output).toEqual({
      url: 'https://example.com/',
      navigated: false,
      urlChanged: false,
      newTabs: [],
      dialog: null,
      settled: true,
      typed: 6,
    });
  });

  it('focuses the ref with the caret at the end and never selects or clears the field', async () => {
    const focus = vi.fn((_tabId: number, _ref: string, _end?: boolean) => undefined);
    const { tool, ctx, log } = await setupField({ focus: later(focus) });

    await drain(tool('type').execute({ tab_id: 1, ref: 'f0e1', text: 'x' }, ctx));

    expect(focus).toHaveBeenCalledWith(1, 'f0e1', true);
    expect(log).not.toContain('page.selectContents');
    expect(log.indexOf('page.inspect')).toBeLessThan(log.indexOf('page.focus'));
    expect(log.indexOf('page.scrollTo')).toBeLessThan(log.indexOf('page.focus'));

    expect(log.slice(log.indexOf('page.domQuiet'))).toEqual([
      'page.domQuiet',
      'tabs.get',
      'page.probe',
      'tabs.frames',
    ]);
  });

  it('presses Enter after the text with submit', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('type').execute({ tab_id: 1, text: 'go', submit: true }, ctx));

    expect(typed(cdp.sent).slice(-2)).toEqual(['keyDown:Enter:\r', 'keyUp:Enter:']);
  });

  it('types into the focused field without a ref, and fails not_editable when nothing editable has focus', async () => {
    const { tool, ctx } = await setupBrowser({
      page: { focused: later(() => ({ ...FIELD, editable: false, role: '', name: '' })) },
    });

    const error = await failure(tool('type').execute({ tab_id: 1, text: 'x' }, ctx));

    expect(error).toMatchObject({ code: 'not_editable' });
  });

  it('reports a password field as redacted', async () => {
    const { tool, ctx } = await setupField({
      inspect: later(() => ({ ...TARGET, redacted: true, name: 'Password' })),
      focused: later(() => ({ ...FIELD, name: 'Password' })),
    });

    await drain(tool('type').execute({ tab_id: 1, ref: 'f0e1', text: 'secret' }, ctx));

    expect(ctx.reports.at(-1)).toMatchObject({ redacted: 'true' });
  });

  it('stops and says how far it got when focus moves to another field mid-text', async () => {
    let reads = 0;
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        focused: later(() => (++reads > 3 ? { ...FIELD, name: 'Other' } : FIELD)),
      },
    });

    const text = 'x'.repeat(FOCUS_CHECK_EVERY * 3);
    const error = await failure(tool('type').execute({ tab_id: 1, text }, ctx));

    expect(error).toMatchObject({
      code: 'input_mismatch',
      detail: { typed: FOCUS_CHECK_EVERY, sent: FOCUS_CHECK_EVERY * 2, total: text.length },
    });

    expect(typed(cdp.sent).filter((entry) => entry.startsWith('keyDown'))).toHaveLength(
      FOCUS_CHECK_EVERY * 2,
    );
  });

  it('checks focus after the last character of a short text too', async () => {
    let reads = 0;
    const { tool, ctx } = await setupBrowser({
      page: { focused: later(() => (++reads > 2 ? { ...FIELD, frameId: 3 } : FIELD)) },
    });

    const error = await failure(tool('type').execute({ tab_id: 1, text: 'abc' }, ctx));

    expect(error).toMatchObject({ code: 'input_mismatch', detail: { typed: 0, sent: 3 } });
  });

  it('asks for input permission', async () => {
    const { tool } = await setupBrowser();

    expect(tool('type').permission).toBe('input');
  });
});

describe('type by ref refuses what fill refuses (sidekick-17 req. 1)', () => {
  it('sends no keys when focus doesn’t land on an editable ref', async () => {
    const button = {
      frameId: 0,
      frameOrigin: 'https://example.com',
      role: 'button',
      name: 'Delete account',
    };

    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        inspect: later(() => ({ ...button, redacted: false })),
        focused: later(() => ({ ...button, editable: false })),
      },
    });

    const error = await failure(tool('type').execute({ tab_id: 1, ref: 'f0e1', text: ' ' }, ctx));

    expect(error).toMatchObject({ code: 'invalid_target', message: /didn’t land on f0e1/ });
    expect(typed(cdp.sent)).toEqual([]);
  });

  it('sends no keys when focus stays on another field, as with a disabled ref', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        inspect: later(() => ({ ...FIELD, name: 'Locked', redacted: false })),
        focused: later(() => FIELD),
      },
    });

    const error = await failure(tool('type').execute({ tab_id: 1, ref: 'f0e2', text: 'abc' }, ctx));

    expect(error).toMatchObject({ code: 'invalid_target' });
    expect(typed(cdp.sent)).toEqual([]);
  });
});
