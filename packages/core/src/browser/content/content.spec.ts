// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://example.com/", "settings": { "disableIframePageLoading": true } }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { stitch } from '../worker/stitch';
import { createContent } from '.';

type Handlers = ReturnType<typeof createContent>['handlers'];

const closedRoots = new WeakMap<Element, ShadowRoot>();

const AUTOCOMPLETE = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-name',
];

const attachShadow = Element.prototype.attachShadow;

const cleanups: (() => void)[] = [];

function unwrap<T>(
  outcome:
    | { ok: T }
    | { error: { code: ToolError['code']; message: string; detail?: ToolError['detail'] } },
) {
  if ('error' in outcome) {
    throw new ToolError(outcome.error.code, outcome.error.message, outcome.error.detail);
  }

  return outcome.ok;
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function setup({ visible = false } = {}) {
  const worker = {
    visible: vi.fn(() => Promise.resolve(visible)),
    stop: vi.fn(() => Promise.resolve()),
    identify: vi.fn(() => Promise.resolve({ frameId: 0, key: 'secret' })),
  };

  const { handlers, indicator } = createContent({ top: true, worker });

  cleanups.push(() => indicator()?.set({ visible: false }));

  const snapshot = async (input: Partial<Parameters<Handlers['page.snapshot']>[0]> = {}) =>
    unwrap(
      await handlers['page.snapshot']({ frameId: 0, scope: 'page', max_chars: 30_000, ...input }),
    );

  const text = async (input: Partial<Parameters<Handlers['page.snapshot']>[0]> = {}) =>
    (await snapshot(input)).lines
      .map((line) => `${'  '.repeat(line.depth)}${line.text}`)
      .join('\n');

  const inspect = async (ref: string, doc?: string) =>
    unwrap(await handlers['page.inspect']({ ref, doc }));

  return { handlers, indicator, worker, snapshot, text, inspect };
}

function refOf(text: string, label: string) {
  const ref = text
    .split('\n')
    .filter((entry) => entry.includes(label))
    .map((entry) => /\[(f\d+e\d+)\]/.exec(entry)?.[1])
    .find((found) => found !== undefined);

  if (!ref) throw new Error(`No ref for ${label} in:\n${text}`);

  return ref;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Fixture';

  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    const root = attachShadow.call(this, init);

    if (init.mode === 'closed') closedRoots.set(this, root);

    return root;
  });

  Object.assign(globalThis, {
    chrome: {
      runtime: {
        id: 'sidekicktestid',
      },
      dom: {
        openOrClosedShadowRoot: (element: HTMLElement) =>
          element.shadowRoot ?? closedRoots.get(element) ?? null,
      },
    },
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();

  vi.restoreAllMocks();
});

describe('snapshot refs', () => {
  it('keeps refs stable across two snapshots', async () => {
    document.body.innerHTML = '<h1>Shop</h1><button>Go</button><a href="/docs">Docs</a>';

    const { text } = setup();
    const first = await text();

    expect(first).toContain('- button "Go" [f0e');
    expect(await text()).toBe(first);
  });

  it('names a search form’s fields as Amazon marks them up, and a submit input by its value', async () => {
    document.body.innerHTML = [
      '<form role="search">',
      '<label for="dept" style="display: none">Select the department you want to search in</label>',
      '<select id="dept" title="Search in"><option>All Departments</option></select>',
      '<label for="q" style="display: none">Search Amazon</label>',
      '<input type="text" id="q" value="usb c cable" aria-label="Search Amazon" placeholder="Search Amazon" />',
      '<input type="submit" value="Go" />',
      '</form>',
    ].join('');

    const text = await setup().text();

    expect(text).toContain('- combobox "Select the department you want to search in"');
    expect(text).toContain('- textbox "Search Amazon" value="usb c cable" [f0e');
    expect(text).toContain('- button "Go" [f0e');
  });

  it('names refs after the frame the worker addresses', async () => {
    document.body.innerHTML = '<button>Go</button>';

    expect(await setup().text({ frameId: 3 })).toContain('[f3e1]');
  });

  it('gives stale_ref removed when the element left the page', async () => {
    document.body.innerHTML = '<button>Go</button>';

    const { text, inspect } = setup();
    const ref = refOf(await text(), 'Go');

    document.body.innerHTML = '<button>Go</button>';

    const error = await failure(inspect(ref));

    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'stale_ref', detail: { reason: 'removed' } });
  });

  it('gives stale_ref changed when a recycled node shows something else', async () => {
    document.body.innerHTML = '<ul><li><a href="/a">Alpha</a></li></ul>';

    const { text, inspect } = setup();
    const ref = refOf(await text(), 'Alpha');
    const link = document.querySelector('a');

    if (!link) throw new Error('No link');

    link.textContent = 'Beta';
    link.setAttribute('href', '/b');

    expect(await failure(inspect(ref))).toMatchObject({
      code: 'stale_ref',
      detail: { reason: 'changed' },
    });
  });

  it('gives stale_ref removed for a ref from an earlier document', async () => {
    document.body.innerHTML = '<button>Go</button>';

    const { text, inspect } = setup();
    const ref = refOf(await text(), 'Go');

    expect(await failure(inspect(ref, 'an-earlier-document'))).toMatchObject({
      code: 'stale_ref',
      detail: { reason: 'removed' },
    });
  });
});

describe('snapshot coverage', () => {
  it('reads inside a closed shadow root through chrome.dom.openOrClosedShadowRoot', async () => {
    document.body.innerHTML = '<div id="host"></div>';

    const host = document.getElementById('host');

    if (!host) throw new Error('No host');

    host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Inside</button>';

    const { text, inspect } = setup();
    const ref = refOf(await text(), 'Inside');

    expect(await inspect(ref)).toEqual({ frameOrigin: 'https://example.com', redacted: false });
  });

  it('marks a child frame for the worker, or one line when Chrome reports no frame for it', async () => {
    document.body.innerHTML =
      '<iframe title="Payment" src="https://pay.test/card"></iframe><iframe title="Ads" src="https://ads.test/"></iframe>';

    const { lines } = await setup().snapshot({
      children: [{ frameId: 3, url: 'https://pay.test/card' }],
    });

    expect(lines).toEqual([
      { depth: 0, text: '- iframe "Payment"', frame: 3 },
      { depth: 0, text: '- iframe "Ads" (not readable)' },
    ]);
  });

  it('matches frames by URL, then without the hash, then in order, skipping other extensions’ frames', async () => {
    document.body.innerHTML = [
      '<iframe title="Moved" src="https://a.test/start"></iframe>',
      '<iframe title="Extension" src="chrome-extension://otherextension/frame.html"></iframe>',
      '<iframe title="Hash" src="https://b.test/page#top"></iframe>',
      '<iframe title="Exact" src="https://c.test/"></iframe>',
    ].join('');

    const { lines } = await setup().snapshot({
      children: [
        { frameId: 7, url: 'https://c.test/' },
        { frameId: 8, url: 'https://a.test/after-redirect' },
        { frameId: 9, url: 'https://b.test/page#bottom' },
      ],
    });

    expect(lines).toEqual([
      { depth: 0, text: '- iframe "Moved"', frame: 8 },
      { depth: 0, text: '- iframe "Extension" (not readable)' },
      { depth: 0, text: '- iframe "Hash"', frame: 9 },
      { depth: 0, text: '- iframe "Exact"', frame: 7 },
    ]);
  });

  it('matches a frame that announced its frame id exactly, with the worker’s key only', async () => {
    document.body.innerHTML = [
      '<iframe title="First" src="https://a.test/"></iframe>',
      '<iframe title="Second" src="https://b.test/"></iframe>',
      '<iframe title="Forged" src="https://c.test/"></iframe>',
    ].join('');

    const content = setup();
    const [first, second, forged] = Array.from(document.querySelectorAll('iframe'));
    const page = vi.fn();

    const asks: unknown[] = [];

    for (const frame of [first, second, forged]) {
      const child = { postMessage: (message: unknown) => asks.push(message) };

      if (frame) Object.defineProperty(frame, 'contentWindow', { value: child });
    }

    addEventListener('message', page);
    cleanups.push(() => removeEventListener('message', page));

    const announce = (frame: HTMLIFrameElement | undefined, key: string, frameId: number) =>
      dispatchEvent(
        new MessageEvent('message', {
          data: { sidekickFrame: key, frameId },
          source: frame?.contentWindow ?? null,
        }),
      );

    announce(second, 'secret', 4);
    announce(first, 'secret', 5);
    announce(forged, 'guess', 4);

    const { lines } = await content.snapshot({
      key: 'secret',
      children: [
        { frameId: 4, url: 'https://a.test/' },
        { frameId: 5, url: 'https://b.test/' },
        { frameId: 6, url: 'https://elsewhere.test/' },
      ],
    });

    expect(lines).toEqual([
      { depth: 0, text: '- iframe "First"', frame: 5 },
      { depth: 0, text: '- iframe "Second"', frame: 4 },
      { depth: 0, text: '- iframe "Forged"', frame: 6 },
    ]);

    expect(asks).toEqual([{ sidekickAsk: true }, { sidekickAsk: true }, { sidekickAsk: true }]);
    expect(page).not.toHaveBeenCalled();
  });

  it('uses a frame id a child announced even when webNavigation left the child out', async () => {
    document.body.innerHTML = '<iframe title="Runner" src="https://play.test/runner"></iframe>';

    const content = setup();
    const frame = document.querySelector('iframe');
    const child = { postMessage: () => undefined };

    if (frame) Object.defineProperty(frame, 'contentWindow', { value: child });

    dispatchEvent(
      new MessageEvent('message', {
        data: { sidekickFrame: 'secret', frameId: 12 },
        source: child as unknown as Window,
      }),
    );

    const { lines } = await content.snapshot({ key: 'secret', children: [] });

    expect(lines).toEqual([{ depth: 0, text: '- iframe "Runner"', frame: 12 }]);
  });

  it('summarises a container’s items outside the viewport band', async () => {
    document.body.innerHTML = `<ul>${Array.from({ length: 10 }, (_, index) => `<li data-top="${index * 1000 - 3000}"><a href="/${index}">Row ${index}</a></li>`).join('')}</ul>`;

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const top = this.closest('[data-top]')?.getAttribute('data-top');

      return top === null || top === undefined
        ? new DOMRect()
        : new DOMRect(0, Number(top), 200, 40);
    });

    const text = await setup().text({ scope: 'viewport' });

    expect(text).toContain('… 3 more items above');
    expect(text).toContain('… 5 more items below');
    expect(text).toContain('"Row 3"');
    expect(text).toContain('"Row 4"');
    expect(text).not.toContain('"Row 2"');
    expect(text).not.toContain('"Row 5"');
  });

  it('stops at max_chars and says it truncated', async () => {
    document.body.innerHTML = Array.from(
      { length: 200 },
      (_, index) => `<button>Button ${index}</button>`,
    ).join('');

    const { lines, truncated } = await setup().snapshot({ max_chars: 1_000 });
    const chars = lines.reduce((sum, line) => sum + line.depth * 2 + line.text.length + 1, 0);

    expect(truncated).toBe(true);
    expect(chars).toBeLessThanOrEqual(1_000);
  });
});

describe('redaction', () => {
  it.each(AUTOCOMPLETE)('hides a field with autocomplete=%s', async (autocomplete) => {
    document.body.innerHTML = `<label>Secret <input autocomplete="${autocomplete}" value="hunter2"></label>`;

    const { snapshot, inspect } = setup();
    const outline = await snapshot();
    const text = outline.lines.map((line) => line.text).join('\n');

    expect(text).toContain('value=[redacted]');
    expect(text).not.toContain('hunter2');
    expect(stitch(new Map([[0, outline]]), 0, 30_000).redacted).toBe(1);
    expect(await inspect(refOf(text, 'Secret'))).toMatchObject({ redacted: true });
  });

  it('hides a password field, and shows an ordinary one', async () => {
    document.body.innerHTML =
      '<label>Password <input type="password" value="hunter2"></label><label>Name <input value="Ada"></label>';

    const outline = await setup().snapshot();
    const text = outline.lines.map((line) => line.text).join('\n');

    expect(text).toContain('- textbox "Password" value=[redacted]');
    expect(text).toContain('- textbox "Name" value="Ada"');
    expect(stitch(new Map([[0, outline]]), 0, 30_000).redacted).toBe(1);
  });

  it('neither emits nor counts 300 hidden inputs', async () => {
    document.body.innerHTML = `<form>${'<input type="hidden" name="token" value="x">'.repeat(300)}<button>Send</button></form>`;

    const outline = await setup().snapshot();

    expect(outline.lines.map((line) => line.text)).toEqual(['- form', '- button "Send" [f0e1]']);
    expect(stitch(new Map([[0, outline]]), 0, 30_000).redacted).toBe(0);
  });
});

describe('indicator', () => {
  function hostOf() {
    const host = [...document.documentElement.children].find((element) => closedRoots.has(element));

    if (!host) throw new Error('No indicator');

    return host;
  }

  it('shows when the worker says the tab is in a run', async () => {
    setup({ visible: true });

    await vi.waitFor(() => expect(hostOf().isConnected).toBe(true));
  });

  it('stays out of snapshots, even moved into the body', async () => {
    document.body.innerHTML = '<button>Go</button>';

    const { handlers, text } = setup();

    unwrap(await handlers['page.indicator']({ visible: true }));
    document.body.append(hostOf());

    expect(await text()).toBe('- button "Go" [f0e1]');
  });

  it('comes back when the page removes it during a run', async () => {
    const { handlers } = setup();

    unwrap(await handlers['page.indicator']({ visible: true }));

    const host = hostOf();

    host.remove();

    await vi.waitFor(() => expect(host.isConnected).toBe(true));

    unwrap(await handlers['page.indicator']({ visible: false }));

    expect(host.isConnected).toBe(false);
  });

  it('ignores a synthetic click on Stop', async () => {
    const { handlers, worker } = setup();

    unwrap(await handlers['page.indicator']({ visible: true }));

    const stop = closedRoots.get(hostOf())?.querySelector('button');

    stop?.click();
    stop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(stop?.textContent).toBe('Stop Sidekick');
    expect(worker.stop).not.toHaveBeenCalled();
  });
});
