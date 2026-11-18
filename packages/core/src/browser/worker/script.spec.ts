import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVAL_TAG } from '../../protocol';
import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, sentMethods, setupBrowser } from './harness';
import { MAX_RESULT_CHARS, SCRIPT_TIMEOUT_MS } from './script';

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

    cdp.replies.set('Runtime.evaluate', evaluates({ title: 'Example', count: 2 }));

    const { output } = await drain(
      tool('eval').execute({ tab_id: 1, script: 'await fetchTitle()' }, ctx),
    );

    expect(output).toEqual({ value: '{"title":"Example","count":2}', truncated: false });

    expect(cdp.sent.find(({ method }) => method === 'Runtime.evaluate')?.params).toEqual({
      expression: 'await fetchTitle()',
      replMode: true,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
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

  it('says a result that isn’t JSON can’t come back', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.sendErrors.set('Runtime.evaluate', [new Error('Object reference chain is too long')]);

    const error = await failure(tool('eval').execute({ tab_id: 1, script: 'window' }, ctx));

    expect(error).toMatchObject({ code: 'script_error', message: /isn’t JSON/ });
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

    await vi.advanceTimersByTimeAsync(10);

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
      returnByValue: true,
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
