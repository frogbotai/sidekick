import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVAL_TAG } from '../../protocol';
import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, sentMethods, setupBrowser } from './harness';
import { DIALOG_SETTLE_MS, MAX_RESULT_CHARS, SCRIPT_TIMEOUT_MS } from './script';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function evaluates(value: unknown) {
  return () => ({ result: { type: typeof value, value } });
}

describe('eval without a ref (sidekick-17 req. 15-17)', () => {
  it('runs in the main world, awaits promises and returns JSON text', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({ result: { type: 'object', objectId: 'res-1' } }));

    cdp.replies.set('Runtime.callFunctionOn', () => ({
      result: { type: 'string', value: '{"title":"Example","count":2}' },
    }));

    const { output } = await drain(
      tool('eval').execute({ tab_id: 1, script: 'await fetchTitle()' }, ctx),
    );

    expect(output).toEqual({ value: '{"title":"Example","count":2}', truncated: false });

    expect(cdp.sent.find(({ method }) => method === 'Runtime.evaluate')?.params).toEqual({
      expression: 'await fetchTitle()',
      replMode: true,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
    });

    expect(
      cdp.sent.find(({ method }) => method === 'Runtime.callFunctionOn')?.params,
    ).toMatchObject({ objectId: 'res-1', returnByValue: true });

    expect(cdp.sent).toContainEqual(
      expect.objectContaining({ method: 'Runtime.releaseObject', params: { objectId: 'res-1' } }),
    );
  });

  it('returns null for undefined', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({ result: { type: 'undefined' } }));

    const { output } = await drain(tool('eval').execute({ tab_id: 1, script: 'void 0' }, ctx));

    expect(output).toEqual({ value: 'null', truncated: false });
  });

  it('cuts a long result and says so', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', evaluates('x'.repeat(MAX_RESULT_CHARS * 2)));

    const { output } = await drain(tool('eval').execute({ tab_id: 1, script: 'big' }, ctx));

    expect(output).toEqual({ value: `"${'x'.repeat(MAX_RESULT_CHARS - 1)}`, truncated: true });
  });

  it('fails with the exception’s message and line when the script throws', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 1,
        exception: { type: 'object', description: 'Error: nope\n    at <anonymous>:2:7' },
      },
    }));

    const error = await failure(tool('eval').execute({ tab_id: 1, script: '\nthrow nope' }, ctx));

    expect(error).toMatchObject({ code: 'script_error', message: 'Error: nope (line 2)' });
  });

  it.each([
    ['TypeError: sidekick:a DOM node\n    at JSON.stringify', /holds a DOM node/],
    ['TypeError: sidekick:a Map', /holds a Map/],
    ['TypeError: Converting circular structure to JSON', /refers to itself/],
  ])('says a result that isn’t JSON can’t come back: %s', async (description, message) => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({ result: { type: 'object', objectId: 'res-1' } }));

    cdp.replies.set('Runtime.callFunctionOn', () => ({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 0,
        exception: { type: 'object', description },
      },
    }));

    const error = await failure(tool('eval').execute({ tab_id: 1, script: 'document.body' }, ctx));

    expect(error).toMatchObject({ code: 'script_error', message });
    expect(sentMethods(cdp.sent)).toContain('Runtime.releaseObject');
  });

  it('never runs the script twice when the debugger detaches mid-run', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.sendErrors.set('Runtime.evaluate', [new Error('Detached while handling command.')]);

    const error = await failure(tool('eval').execute({ tab_id: 1, script: 'submit()' }, ctx));

    expect(error).toMatchObject({ code: 'script_error', message: /may have finished/ });
    expect(sentMethods(cdp.sent).filter((method) => method === 'Runtime.evaluate')).toHaveLength(1);
  });

  it('refuses NaN and Infinity, which JSON can’t hold', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({
      result: { type: 'number', unserializableValue: 'Infinity' },
    }));

    const error = await failure(tool('eval').execute({ tab_id: 1, script: '1/0' }, ctx));

    expect(error).toMatchObject({ code: 'script_error', message: /Infinity/ });
  });

  it('stops the script after 30 s and fails with timeout', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => new Promise(() => undefined));

    const running = failure(tool('eval').execute({ tab_id: 1, script: 'for(;;){}' }, ctx));

    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS - 1_000);

    expect(sentMethods(cdp.sent)).not.toContain('Runtime.terminateExecution');

    const error = await running;

    expect(error).toMatchObject({ code: 'timeout', message: /30 s/ });
    expect(sentMethods(cdp.sent)).toContain('Runtime.terminateExecution');
  });

  it('fails at once with the dialog’s message when the script opens one, and dismisses it', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => {
      cdp.emit({
        tabId: 1,
        method: 'Page.javascriptDialogOpening',
        params: { type: 'confirm', message: 'Delete everything?' },
      });

      return new Promise(() => undefined);
    });

    const running = failure(tool('eval').execute({ tab_id: 1, script: 'confirm("x")' }, ctx));

    await vi.advanceTimersByTimeAsync(DIALOG_SETTLE_MS);

    const error = await running;

    expect(error).toMatchObject({
      code: 'script_error',
      message: /confirm dialog saying “Delete everything\?”/,
    });

    expect(cdp.sent).toContainEqual(
      expect.objectContaining({
        method: 'Page.handleJavaScriptDialog',
        params: { accept: false },
      }),
    );

    expect(cdp.listeners()).toBe(0);
  });

  it('stops the script after its first dialog and keeps dismissing dialogs until it ends', async () => {
    const { tool, ctx, cdp } = await setupBrowser();
    const dialog = (message: string) =>
      cdp.emit({
        tabId: 1,
        method: 'Page.javascriptDialogOpening',
        params: { type: 'alert', message },
      });

    cdp.replies.set('Runtime.evaluate', () => {
      dialog('one');

      return new Promise(() => undefined);
    });

    const running = failure(
      tool('eval').execute({ tab_id: 1, script: "alert('one'); alert('two')" }, ctx),
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(sentMethods(cdp.sent)).toContain('Runtime.terminateExecution');

    dialog('two');
    await vi.advanceTimersByTimeAsync(DIALOG_SETTLE_MS);

    expect(await running).toMatchObject({ code: 'script_error', message: /saying “one”/ });

    expect(
      sentMethods(cdp.sent).filter((method) => method === 'Page.handleJavaScriptDialog'),
    ).toHaveLength(2);

    expect(cdp.listeners()).toBe(0);
  });

  it('awaits a promise the script returns', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({
      result: { type: 'object', subtype: 'promise', objectId: 'promise-1' },
    }));

    cdp.replies.set('Runtime.awaitPromise', () => ({ result: { type: 'number', value: 5 } }));

    const { output } = await drain(
      tool('eval').execute({ tab_id: 1, script: 'Promise.resolve(5)' }, ctx),
    );

    expect(output).toEqual({ value: '5', truncated: false });

    expect(cdp.sent.find(({ method }) => method === 'Runtime.awaitPromise')?.params).toEqual({
      promiseObjectId: 'promise-1',
      returnByValue: false,
    });

    expect(cdp.sent).toContainEqual(
      expect.objectContaining({
        method: 'Runtime.releaseObject',
        params: { objectId: 'promise-1' },
      }),
    );
  });

  it('fails with the reason when a returned promise rejects', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({
      result: { type: 'object', subtype: 'promise', objectId: 'promise-1' },
    }));

    cdp.replies.set('Runtime.awaitPromise', () => ({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        lineNumber: 0,
        exception: { type: 'object', description: 'Error: offline\n    at <anonymous>:1:1' },
      },
    }));

    const error = await failure(tool('eval').execute({ tab_id: 1, script: 'load()' }, ctx));

    expect(error).toMatchObject({ code: 'script_error', message: 'Error: offline (line 1)' });
  });

  it('keeps a returned promise within the same 30 s and stops it after', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({
      result: { type: 'object', subtype: 'promise', objectId: 'promise-1' },
    }));

    cdp.replies.set('Runtime.awaitPromise', () => new Promise(() => undefined));

    const running = failure(
      tool('eval').execute({ tab_id: 1, script: 'new Promise(() => {})' }, ctx),
    );

    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);

    expect(await running).toMatchObject({ code: 'timeout', message: /30 s/ });
    expect(sentMethods(cdp.sent)).toContain('Runtime.terminateExecution');
  });

  it('stops a result whose toJSON never returns, instead of leaving it running', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Runtime.evaluate', () => ({ result: { type: 'object', objectId: 'res-1' } }));
    cdp.replies.set('Runtime.callFunctionOn', () => new Promise(() => undefined));

    const running = failure(
      tool('eval').execute({ tab_id: 1, script: '({ toJSON() { for (;;) {} } })' }, ctx),
    );

    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);

    expect(await running).toMatchObject({ code: 'timeout', message: /30 s/ });
    expect(sentMethods(cdp.sent)).toContain('Runtime.terminateExecution');
  });

  it('asks for input permission (D1: B)', async () => {
    const { tool } = await setupBrowser();

    expect(tool('eval').permission).toBe('input');
  });
});

describe('eval with a ref (sidekick-17 req. 14)', () => {
  it('tags the element, finds it through the debugger, calls the function on it and removes the tag', async () => {
    const tags: (string | null)[] = [];
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        tag: later((_tabId: number, _ref: string, token: string | null) => void tags.push(token)),
      },
    });

    cdp.replies.set('DOM.performSearch', () => ({ searchId: 's1', resultCount: 1 }));
    cdp.replies.set('DOM.getSearchResults', () => ({ nodeIds: [42] }));
    cdp.replies.set('DOM.resolveNode', () => ({ object: { objectId: 'node-42' } }));
    cdp.replies.set('Runtime.callFunctionOn', evaluates('Ada'));

    const { output } = await drain(
      tool('eval').execute({ tab_id: 1, ref: 'f0e1', script: '(el) => el.value' }, ctx),
    );

    expect(output).toEqual({ value: '"Ada"', truncated: false });

    const token = tags[0];

    expect(tags).toEqual([token, null]);

    expect(cdp.sent.find(({ method }) => method === 'DOM.performSearch')?.params).toEqual({
      query: `[${EVAL_TAG}="${token}"]`,
    });

    expect(cdp.sent.find(({ method }) => method === 'Runtime.callFunctionOn')?.params).toEqual({
      functionDeclaration: '(el) => el.value',
      objectId: 'node-42',
      arguments: [{ objectId: 'node-42' }],
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
    });

    expect(sentMethods(cdp.sent)).toEqual(
      expect.arrayContaining(['DOM.discardSearchResults', 'Runtime.releaseObject']),
    );
  });

  it('fails invalid_target when the element is in a frame the debugger can’t reach', async () => {
    const { tool, ctx, cdp, log } = await setupBrowser();

    cdp.replies.set('DOM.performSearch', () => ({ searchId: 's1', resultCount: 0 }));

    const error = await failure(
      tool('eval').execute({ tab_id: 1, ref: 'f3e1', script: '(el) => el.value' }, ctx),
    );

    expect(error).toMatchObject({ code: 'invalid_target', message: /another site/ });
    expect(log.filter((entry) => entry === 'page.tag')).toHaveLength(2);
  });

  it('says the script must be a function when it isn’t one', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('DOM.performSearch', () => ({ searchId: 's1', resultCount: 1 }));
    cdp.replies.set('DOM.getSearchResults', () => ({ nodeIds: [42] }));
    cdp.replies.set('DOM.resolveNode', () => ({ object: { objectId: 'node-42' } }));

    cdp.sendErrors.set('Runtime.callFunctionOn', [
      new Error('Given expression does not evaluate to a function'),
    ]);

    const error = await failure(
      tool('eval').execute({ tab_id: 1, ref: 'f0e1', script: 'document.title' }, ctx),
    );

    expect(error).toMatchObject({ code: 'script_error', message: /must be a function/ });
  });

  it('fails stale_ref before running anything when the ref is stale', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        inspect: later(() => {
          throw new ToolError('stale_ref', 'gone', { reason: 'removed' });
        }),
      },
    });

    const error = await failure(
      tool('eval').execute({ tab_id: 1, ref: 'f0e1', script: '(el) => 1' }, ctx),
    );

    expect(error).toMatchObject({ code: 'stale_ref' });
    expect(sentMethods(cdp.sent)).not.toContain('Runtime.callFunctionOn');
  });
});
