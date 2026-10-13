// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { frameProtocol } from '../../protocol';
import { answerFrames } from '../../rpc/frames';
import { installFakeRuntime } from '../../testing/fakeRuntime';
import { ToolError } from '../../tool/tool';
import { createContent } from '../content';
import { fakeTabs } from './fakes';
import { drain, failure, setupBrowser } from './harness';
import { chromePage } from './page';

async function browserOverContent(html: string) {
  document.body.innerHTML = html;

  const setup = await setupBrowser({ page: chromePage({ tabs: fakeTabs([], []) }) });

  installFakeRuntime();

  Object.assign(chrome, {
    dom: { openOrClosedShadowRoot: (element: HTMLElement) => element.shadowRoot },
  });

  const { handlers } = createContent({
    top: false,
    worker: {
      visible: () => Promise.resolve(false),
      stop: () => Promise.resolve(),
      identify: () => Promise.resolve({ frameId: 0, key: 'worker-key' }),
    },
  });

  answerFrames(frameProtocol, { 'frame.ping': () => ({ url: location.href }), ...handlers });

  const snapshot = async () => {
    const result = await drain(
      setup.tool('snapshot').execute({ tab_id: 1, scope: 'page' }, setup.ctx),
    );

    return result.output as { snapshot: string; redacted: number };
  };

  return { ...setup, snapshot };
}

function refFor(snapshot: string, label: string) {
  const ref = new RegExp(`"${label}".*\\[(f\\d+e\\d+)\\]`).exec(snapshot)?.[1];

  if (!ref) throw new Error(`No ref for ${label} in:\n${snapshot}`);

  return ref;
}

beforeEach(() => {
  vi.useFakeTimers();

  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 10, 200, 30),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the worker’s Page over the content script', () => {
  it('reports exactly the redacted lines it emits, not hidden inputs', async () => {
    const { snapshot } = await browserOverContent(
      `<label>Password <input type="password" value="hunter2"></label>
       <label>Card <input autocomplete="cc-number" value="4111111111111111"></label>
       <label>Name <input value="Ada"></label>
       ${'<input type="hidden" name="csrf" value="x">'.repeat(300)}`,
    );

    const { snapshot: text, redacted } = await snapshot();

    expect(redacted).toBe(2);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('4111');
    expect(text).toContain('value="Ada"');
  });

  it('never echoes a redacted value when fill can’t replace it', async () => {
    const setup = await browserOverContent(
      '<label>Password <input type="password" value="hunter2"></label>',
    );

    const field = document.querySelector('input');

    if (!field) throw new Error('No field');

    Object.assign(document, { elementsFromPoint: () => [field] });

    const ref = refFor((await setup.snapshot()).snapshot, 'Password');
    const error = await failure(
      setup.tool('fill').execute({ tab_id: 1, ref, text: 'swordfish' }, setup.ctx),
    );

    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'input_mismatch', detail: undefined });
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(error instanceof Error ? error.message : '').not.toContain('hunter2');
  });

  it('turns a ref whose element left the page into stale_ref before any input', async () => {
    const setup = await browserOverContent('<button>Go</button>');
    const ref = refFor((await setup.snapshot()).snapshot, 'Go');

    document.body.innerHTML = '<button>Go</button>';

    const error = await failure(setup.tool('click').execute({ tab_id: 1, ref }, setup.ctx));

    expect(error).toMatchObject({ code: 'stale_ref', detail: { reason: 'removed' } });
    expect(setup.cdp.sent.filter(({ method }) => method.startsWith('Input.'))).toEqual([]);
  });
});
