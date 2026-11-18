import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { MESSAGE_LIMIT } from './dialogs';
import { later } from './fakes';
import { callerOf, drain, failure, setupBrowser } from './harness';
import { COMMAND_TIMEOUT_MS } from './sessions';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function mouseTypes(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent
    .filter(({ method }) => method === 'Input.dispatchMouseEvent')
    .map(({ params }) => params.type);
}

async function withDialog(on: 'mousePressed' | 'mouseReleased' = 'mouseReleased') {
  const setup = await setupBrowser();
  const { cdp } = setup;

  cdp.replies.set('Input.dispatchMouseEvent', (params, tabId) => {
    if (params.type !== on) return {};

    const closed = new Promise((resolve) => {
      const stop = cdp.onEvent((event) => {
        if (event.method !== 'Page.javascriptDialogClosed') return;

        stop();
        resolve({});
      });
    });

    cdp.openDialog(tabId, { type: 'confirm', message: 'Delete the draft?' });

    return closed;
  });

  return { ...setup, call: callerOf(setup) };
}

describe('the pending-dialog record (req. 5)', () => {
  it('holds the opened dialog, capped, until it closes', async () => {
    const { cdp, runtime } = await setupBrowser();
    const { dialogs } = runtime.env;

    cdp.openDialog(1, { type: 'prompt', message: 'x'.repeat(5_000), defaultPrompt: 'Ada' });

    expect(dialogs.get(1)).toEqual({
      type: 'prompt',
      message: 'x'.repeat(MESSAGE_LIMIT),
      defaultValue: 'Ada',
    });

    expect(dialogs.get(2)).toBeNull();

    cdp.emit({ tabId: 1, method: 'Page.javascriptDialogClosed', params: {} });

    expect(dialogs.get(1)).toBeNull();
  });

  it('clears when the tab detaches or loads a new document, not on a # change', async () => {
    const { cdp, tabs, runtime } = await setupBrowser();
    const { dialogs } = runtime.env;

    cdp.openDialog(1, { type: 'alert', message: 'Hi' });
    tabs.commit({ tabId: 1, url: 'https://example.com/#a', sameDocument: true });

    expect(dialogs.get(1)).not.toBeNull();

    tabs.commit({ tabId: 1 });

    expect(dialogs.get(1)).toBeNull();

    cdp.openDialog(1, { type: 'alert', message: 'Hi' });
    cdp.detachByChrome(1, 'target_closed');

    expect(dialogs.get(1)).toBeNull();
  });

  it('ignores an event it can’t read', async () => {
    const { cdp, runtime } = await setupBrowser();

    cdp.openDialog(1, { type: 'toast', message: 'Hi' });

    expect(runtime.env.dialogs.get(1)).toBeNull();
  });

  it('enables the Page domain when it attaches', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(cdp.sent.map(({ method }) => method)).toContain('Page.enable');
  });
});

describe('an action that raises a dialog (req. 3, 4)', () => {
  it('ends as soon as the dialog opens, with it in the result', async () => {
    const { call } = await withDialog();
    let result: unknown;

    void call('click', { tab_id: 1, ref: 'f0e1' }).then((value) => (result = value));

    await vi.advanceTimersByTimeAsync(50);

    expect(result).toEqual({
      ok: expect.objectContaining({
        output: {
          url: 'https://example.com/',
          navigated: false,
          urlChanged: false,
          settled: false,
          newTabs: [],
          dialog: { type: 'confirm', message: 'Delete the draft?', defaultValue: '' },
        },
      }),
    });
  });

  it('sends no further input once a dialog opens mid-click, even after it is answered', async () => {
    const { call, cdp } = await withDialog('mousePressed');

    await drain(call('click', { tab_id: 1, ref: 'f0e1' }));
    await drain(call('dialog', { tab_id: 1, action: 'dismiss' }));
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);

    expect(mouseTypes(cdp.sent)).toEqual(['mouseMoved', 'mousePressed']);
  });

  it.each([
    ['press', 'focus', { key: 'Enter' }],
    ['click', 'scrollTo', {}],
    ['fill', 'scrollTo', { text: 'hi' }],
    ['check', 'scrollTo', { checked: true }],
  ] as const)(
    '%s ends at once when its %s step raises a dialog, before the input',
    async (tool, step, extra) => {
      let raise = () => undefined as void;
      const setup = await setupBrowser({
        page: {
          [step]: () => {
            raise();

            return new Promise(() => undefined);
          },
        },
      });

      raise = () => setup.cdp.openDialog(1, { type: 'alert', message: 'Focused!' });

      const call = callerOf(setup);
      let result: unknown;

      void call(tool, { tab_id: 1, ref: 'f0e1', ...extra }).then((value) => (result = value));

      await vi.advanceTimersByTimeAsync(50);

      expect(result).toMatchObject({ ok: { output: { dialog: { type: 'alert' } } } });
    },
  );

  it('check reports the state as it was, unchanged, when the click raises a dialog', async () => {
    const { call } = await withDialog();

    const result = await drain(call('check', { tab_id: 1, ref: 'f0e1', checked: true }));

    expect(result).toMatchObject({
      ok: { output: { checked: false, changed: false, dialog: { type: 'confirm' } } },
    });
  });
});

describe('while a dialog is open (req. 6)', () => {
  it('frees the tab: other calls start at once, and page calls fail dialog_open instead of hanging', async () => {
    const { call } = await withDialog();

    await drain(call('click', { tab_id: 1, ref: 'f0e1' }));

    const snapshot = await drain(call('snapshot', { tab_id: 1 }), 10, 5);

    expect(snapshot).toMatchObject({
      error: {
        code: 'dialog_open',
        detail: { type: 'confirm', message: 'Delete the draft?', defaultValue: '' },
      },
    });

    expect(await drain(call('click', { tab_id: 1, ref: 'f0e1' }), 10, 5)).toMatchObject({
      error: { code: 'dialog_open' },
    });

    expect(await drain(call('tabs_list', {}), 10, 5)).toMatchObject({ ok: {} });
  });

  it('runs other calls normally once the dialog is accepted', async () => {
    const { call, cdp } = await withDialog();

    await drain(call('click', { tab_id: 1, ref: 'f0e1' }));
    cdp.replies.delete('Input.dispatchMouseEvent');

    expect(await drain(call('dialog', { tab_id: 1, action: 'accept' }))).toMatchObject({
      ok: { output: { dialog: null } },
    });

    expect(await drain(call('click', { tab_id: 1, ref: 'f0e1' }))).toMatchObject({
      ok: { output: { settled: true, dialog: null } },
    });
  });
});

describe('the dialog tool (req. 7, 8)', () => {
  it('get gives the open dialog, or null when none is open', async () => {
    const { call, cdp } = await setupBrowser().then((setup) => ({
      ...setup,
      call: callerOf(setup),
    }));

    expect(await drain(call('dialog', { tab_id: 1, action: 'get' }))).toMatchObject({
      ok: { output: { dialog: null, settled: true } },
    });

    cdp.openDialog(1, { type: 'alert', message: 'Saved' });

    expect(await drain(call('dialog', { tab_id: 1, action: 'get' }))).toMatchObject({
      ok: { output: { dialog: { type: 'alert', message: 'Saved', defaultValue: '' } } },
    });
  });

  it('accepts a prompt with its text, then reports the dialog gone', async () => {
    const { tool, ctx, cdp, runtime } = await setupBrowser();

    cdp.openDialog(1, { type: 'prompt', message: 'Your name?', defaultPrompt: '' });

    const { output } = await drain(
      tool('dialog').execute({ tab_id: 1, action: 'accept', promptText: 'Ada' }, ctx),
    );

    expect(cdp.sent.find(({ method }) => method === 'Page.handleJavaScriptDialog')).toMatchObject({
      tabId: 1,
      params: { accept: true, promptText: 'Ada' },
    });

    expect(output).toMatchObject({ dialog: null });
    expect(runtime.env.dialogs.get(1)).toBeNull();
  });

  it('dismisses with accept: false', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.openDialog(1, { type: 'confirm', message: 'Leave?' });
    await drain(tool('dialog').execute({ tab_id: 1, action: 'dismiss' }, ctx));

    expect(cdp.sent.find(({ method }) => method === 'Page.handleJavaScriptDialog')?.params).toEqual(
      { accept: false },
    );
  });

  it('reports a dialog the answer raised in turn', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.openDialog(1, { type: 'confirm', message: 'Delete?' });

    cdp.replies.set('Page.handleJavaScriptDialog', (_params, tabId) => {
      cdp.emit({ tabId, method: 'Page.javascriptDialogClosed', params: {} });
      cdp.openDialog(tabId, { type: 'alert', message: 'Deleted' });

      return {};
    });

    const { output } = await drain(tool('dialog').execute({ tab_id: 1, action: 'accept' }, ctx));

    expect(output).toMatchObject({ dialog: { type: 'alert', message: 'Deleted' } });
  });

  it('fails, saying so, when no dialog is open, or Chrome has none showing', async () => {
    const { tool, ctx, cdp, runtime } = await setupBrowser();
    const accept = () => tool('dialog').execute({ tab_id: 1, action: 'accept' }, ctx);

    const none = await failure(accept());

    expect(none).toBeInstanceOf(ToolError);
    expect(none).toMatchObject({ code: 'invalid_target' });
    expect((none as Error).message).toMatch(/^No dialog is open on this tab/);

    cdp.openDialog(1, { type: 'alert', message: 'Hi' });
    cdp.sendErrors.set('Page.handleJavaScriptDialog', [new Error('No dialog is showing')]);

    expect(await failure(accept())).toMatchObject({ code: 'invalid_target' });
    expect(runtime.env.dialogs.get(1)).toBeNull();
  });

  it('takes promptText only with accept', async () => {
    const { tool } = await setupBrowser();
    const input = tool('dialog').input;

    expect(input.safeParse({ tab_id: 1, action: 'dismiss', promptText: 'x' }).success).toBe(false);
    expect(input.safeParse({ tab_id: 1, action: 'accept', promptText: 'x' }).success).toBe(true);
  });

  it('asks for input on the tab’s origin, and is refused when input is denied', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.openDialog(1, { type: 'alert', message: 'Hi' });

    ctx.permission.assert = later((request) => {
      ctx.asserts.push(request);

      throw new ToolError('denied', 'Denied.');
    });

    const error = await failure(tool('dialog').execute({ tab_id: 1, action: 'accept' }, ctx));

    expect(error).toMatchObject({ code: 'denied' });
    expect(ctx.asserts).toEqual([{ action: 'input', resource: 'https://example.com' }]);
    expect(cdp.sent.map(({ method }) => method)).not.toContain('Page.handleJavaScriptDialog');
  });
});
