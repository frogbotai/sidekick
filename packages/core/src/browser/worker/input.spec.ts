import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { later } from './fakes';
import { drain, failure, sentMethods, setupBrowser } from './harness';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function codeOf(error: unknown) {
  return error instanceof ToolError ? error.code : error;
}

function inputs(sent: { method: string; params: Record<string, unknown> }[]) {
  return sent.filter(({ method }) => method.startsWith('Input.'));
}

describe('input order (req. 13)', () => {
  it('checks, asserts, re-checks the URL before and after inspecting, attaches, scrolls and hit-tests, sends input, then settles', async () => {
    const { tool, ctx, log } = await setupBrowser();

    const output = await drain(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(log).toEqual([
      'tabs.get',
      'assert.input',
      'tabs.get',
      'page.inspect',
      'tabs.get',
      'cdp.attach',
      'cdp.Network.enable',
      'page.scrollTo',
      'page.indicator',
      'cdp.Input.dispatchMouseEvent',
      'cdp.Input.dispatchMouseEvent',
      'cdp.Input.dispatchMouseEvent',
      'page.domQuiet',
      'tabs.get',
    ]);

    expect(output.output).toEqual({ url: 'https://example.com/', navigated: false, settled: true });
  });

  it('sends the click at the hit-tested point with the button, count and modifiers', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(
      tool('click').execute(
        { tab_id: 1, ref: 'f0e1', button: 'right', count: 2, modifiers: ['Shift', 'Meta'] },
        ctx,
      ),
    );

    expect(
      inputs(cdp.sent).map(({ params }) => [
        params.type,
        params.x,
        params.y,
        params.clickCount,
        params.modifiers,
      ]),
    ).toEqual([
      ['mouseMoved', 100, 200, undefined, undefined],
      ['mousePressed', 100, 200, 1, 12],
      ['mouseReleased', 100, 200, 1, 12],
      ['mousePressed', 100, 200, 2, 12],
      ['mouseReleased', 100, 200, 2, 12],
    ]);
  });

  it('refuses with navigated when pendingUrl leaves the asserted origin, before any input', async () => {
    const setup = await setupBrowser({
      page: {
        inspect: later(() => {
          const tab = setup.tabs.tabs.get(1);

          if (tab) tab.pendingUrl = 'https://elsewhere.test/login';

          return { frameId: 0, frameOrigin: 'https://example.com', redacted: false };
        }),
      },
    });

    const error = await failure(setup.tool('click').execute({ tab_id: 1, ref: 'f0e1' }, setup.ctx));

    expect(codeOf(error)).toBe('navigated');
    expect(setup.cdp.attaching).toEqual([]);
    expect(inputs(setup.cdp.sent)).toEqual([]);
  });

  it('re-asserts with the frame origin for a ref in a cross-origin frame', async () => {
    const { tool, ctx } = await setupBrowser({
      page: {
        inspect: later(() => ({
          frameId: 4,
          frameOrigin: 'http://127.0.0.1:5174',
          redacted: false,
        })),
      },
    });

    await drain(tool('hover').execute({ tab_id: 1, ref: 'f4e2' }, ctx));

    expect(ctx.asserts).toEqual([
      { action: 'input', resource: 'https://example.com' },
      { action: 'input', resource: 'https://example.com', frameOrigin: 'http://127.0.0.1:5174' },
    ]);
  });

  it('refuses with obscured, naming the cover, when the hit-test fails', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        scrollTo: later(() => ({
          point: { x: 1, y: 1 },
          rect: { x: 0, y: 0, width: 2, height: 2 },
          in_view: false,
          obscured_by: 'div.cookie-banner',
        })),
      },
    });

    const error = await failure(tool('click').execute({ tab_id: 1, ref: 'f0e1' }, ctx));

    expect(codeOf(error)).toBe('obscured');

    expect(error instanceof ToolError && error.detail).toEqual({
      obscured_by: 'div.cookie-banner',
    });

    expect(inputs(cdp.sent)).toEqual([]);
  });

  it('refuses a tab outside the run’s group with not_in_group', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    expect(codeOf(await failure(tool('click').execute({ tab_id: 2, ref: 'f0e1' }, ctx)))).toBe(
      'not_in_group',
    );

    expect(ctx.asserts).toEqual([]);
    expect(cdp.attaching).toEqual([]);
  });
});

describe('fill (req. 14)', () => {
  it('selects the contents, then sends one insertText with nothing between them', async () => {
    const { tool, ctx, log, cdp } = await setupBrowser({
      page: { readValue: later(() => 'Hello') },
    });

    await drain(tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: 'Hello' }, ctx));

    const select = log.indexOf('page.selectContents');

    expect(log.slice(select, select + 3)).toEqual([
      'page.selectContents',
      'cdp.Input.insertText',
      'page.readValue',
    ]);

    expect(inputs(cdp.sent)).toEqual([
      { tabId: 1, method: 'Input.insertText', params: { text: 'Hello' } },
    ]);
  });

  it('sends Delete for an empty value', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: '' }, ctx));

    expect(inputs(cdp.sent).map(({ params }) => [params.type, params.key])).toEqual([
      ['rawKeyDown', 'Delete'],
      ['keyUp', 'Delete'],
    ]);
  });

  it('falls back to key events on a mismatch', async () => {
    const reads = ['', 'hi'];
    const { tool, ctx, cdp, log } = await setupBrowser({
      page: { readValue: later(() => reads.shift() ?? '') },
    });

    await drain(tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: 'hi' }, ctx));

    expect(log.filter((entry) => entry === 'page.selectContents')).toHaveLength(2);

    expect(
      inputs(cdp.sent).map(
        ({ method, params }) =>
          `${method}:${String(params.type ?? params.text)}:${String(params.text ?? '')}`,
      ),
    ).toEqual([
      'Input.insertText:hi:hi',
      'Input.dispatchKeyEvent:keyDown:h',
      'Input.dispatchKeyEvent:keyUp:',
      'Input.dispatchKeyEvent:keyDown:i',
      'Input.dispatchKeyEvent:keyUp:',
    ]);
  });

  it('throws input_mismatch when key events don’t take either, without echoing a redacted value', async () => {
    const plain = await setupBrowser({ page: { readValue: later(() => 'nope') } });
    const shown = await failure(
      plain.tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: 'hi' }, plain.ctx),
    );

    expect(codeOf(shown)).toBe('input_mismatch');
    expect(shown instanceof ToolError && shown.detail).toEqual({ actual: 'nope' });

    const secret = await setupBrowser({
      page: {
        readValue: later(() => 'hunter2'),
        inspect: later(() => ({ frameId: 0, frameOrigin: 'https://example.com', redacted: true })),
      },
    });

    const hidden = await failure(
      secret.tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: 'pw' }, secret.ctx),
    );

    expect(codeOf(hidden)).toBe('input_mismatch');
    expect(hidden instanceof ToolError && hidden.detail).toBeUndefined();
    expect(JSON.stringify(hidden instanceof Error && hidden.message)).not.toContain('hunter2');
  });

  it('refuses text longer than the field’s maxlength before sending any input', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        inspect: later(() => ({
          frameId: 0,
          frameOrigin: 'https://example.com',
          redacted: false,
          max_length: 8,
        })),
        readValue: later(() => 'sidekick'),
      },
    });

    const error = await failure(
      tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: 'sidekick test' }, ctx),
    );

    expect(error).toMatchObject({
      code: 'input_mismatch',
      message:
        'f0e1 accepts at most 8 characters, and the text has 13. Shorten it, then fill again.',
      detail: { max_length: 8 },
    });

    expect(inputs(cdp.sent)).toEqual([]);

    await drain(tool('fill').execute({ tab_id: 1, ref: 'f0e1', text: 'sidekick' }, ctx));

    expect(inputs(cdp.sent).map(({ params }) => params.text)).toEqual(['sidekick']);
  });

  it('types at the focused element without a ref (271 D3)', async () => {
    const { tool, ctx, log, cdp } = await setupBrowser();

    await drain(tool('fill').execute({ tab_id: 1, text: 'cell' }, ctx));

    expect(log).not.toContain('page.selectContents');

    expect(inputs(cdp.sent)).toEqual([
      { tabId: 1, method: 'Input.insertText', params: { text: 'cell' } },
    ]);
  });
});

describe('press, select and drag (req. 15)', () => {
  it('adds macOS editing commands on a Mac', async () => {
    const mac = await setupBrowser({ mac: true });

    await drain(mac.tool('press').execute({ tab_id: 1, key: 'Meta+A' }, mac.ctx));

    expect(
      inputs(mac.cdp.sent).map(({ params }) => [
        params.type,
        params.key,
        params.modifiers,
        params.commands,
      ]),
    ).toEqual([
      ['rawKeyDown', 'Meta', 4, undefined],
      ['rawKeyDown', 'A', 4, ['selectAll']],
      ['keyUp', 'A', 4, undefined],
      ['keyUp', 'Meta', 0, undefined],
    ]);

    const other = await setupBrowser({ mac: false });

    await drain(other.tool('press').execute({ tab_id: 1, key: 'ControlOrMeta+A' }, other.ctx));

    expect(inputs(other.cdp.sent).map(({ params }) => [params.key, params.commands])).toEqual([
      ['Control', undefined],
      ['A', []],
      ['A', undefined],
      ['Control', undefined],
    ]);
  });

  it('types the key’s text when only Shift is held', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    await drain(tool('press').execute({ tab_id: 1, key: 'Enter', ref: 'f0e1' }, ctx));

    expect(inputs(cdp.sent).map(({ params }) => [params.type, params.key, params.text])).toEqual([
      ['keyDown', 'Enter', '\r'],
      ['keyUp', 'Enter', undefined],
    ]);
  });

  it('refuses an unknown key', async () => {
    const { tool, ctx } = await setupBrowser();

    expect(codeOf(await failure(tool('press').execute({ tab_id: 1, key: 'Hyper+Q' }, ctx)))).toBe(
      'invalid_target',
    );
  });

  it('selects options and reports missing ones as input_mismatch', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: { selectOptions: later(() => ['red']) },
    });

    const error = await failure(
      tool('select').execute({ tab_id: 1, ref: 'f0e1', values: ['red', 'teal'] }, ctx),
    );

    expect(codeOf(error)).toBe('input_mismatch');
    expect(error instanceof ToolError && error.detail).toEqual({ selected: ['red'] });
    expect(inputs(cdp.sent)).toEqual([]);
  });

  it('drags in at least 5 moves with drag interception on, then off', async () => {
    const { tool, ctx, cdp } = await setupBrowser({
      page: {
        scrollTo: later((_tabId: number, ref: string) => ({
          point: ref === 'f0e1' ? { x: 0, y: 0 } : { x: 80, y: 40 },
          rect: { x: 0, y: 0, width: 1, height: 1 },
          in_view: true,
        })),
      },
    });

    await drain(tool('drag').execute({ tab_id: 1, from: 'f0e1', to: 'f0e2' }, ctx));

    const sent = inputs(cdp.sent);
    const moves = sent.filter(({ params }) => params.type === 'mouseMoved' && params.buttons === 1);

    expect(sent[0]).toEqual({
      tabId: 1,
      method: 'Input.setInterceptDrags',
      params: { enabled: true },
    });

    expect(sent.at(-1)).toEqual({
      tabId: 1,
      method: 'Input.setInterceptDrags',
      params: { enabled: false },
    });

    expect(moves.length).toBeGreaterThanOrEqual(5);
    expect(moves.at(-1)?.params).toMatchObject({ x: 80, y: 40 });
    expect(sent.at(-2)?.params).toMatchObject({ type: 'mouseReleased', x: 80, y: 40 });
  });

  it('finishes an intercepted HTML5 drag with drag events', async () => {
    const { tool, ctx, cdp } = await setupBrowser();

    cdp.replies.set('Input.dispatchMouseEvent', (params) => {
      if (params.type === 'mouseMoved' && params.buttons === 1) {
        cdp.emit({
          tabId: 1,
          method: 'Input.dragIntercepted',
          params: { data: { items: [], dragOperationsMask: 1 } },
        });
      }

      return {};
    });

    await drain(tool('drag').execute({ tab_id: 1, from: 'f0e1', to: { x: 300, y: 300 } }, ctx));

    const drags = inputs(cdp.sent).filter(({ method }) => method === 'Input.dispatchDragEvent');

    expect(drags.map(({ params }) => params.type)).toEqual([
      'dragEnter',
      ...Array(6).fill('dragOver'),
      'drop',
    ]);

    expect(drags.at(-1)?.params).toMatchObject({
      x: 300,
      y: 300,
      data: { items: [], dragOperationsMask: 1 },
    });

    expect(sentMethods(cdp.sent).at(-1)).toBe('Input.setInterceptDrags');
  });
});
