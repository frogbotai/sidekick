import { afterEach, beforeEach, vi } from 'vitest';

import { ToolError } from '../../tool/tool';
import { createContent } from '.';

type Handlers = ReturnType<typeof createContent>['handlers'];

type SnapshotInput = Parameters<Handlers['page.snapshot']>[0];

export const closedRoots = new WeakMap<Element, ShadowRoot>();

const attachShadow = Element.prototype.attachShadow;

export const cleanups: (() => void)[] = [];

export function unwrap<T>(
  outcome:
    | { ok: T }
    | { error: { code: ToolError['code']; message: string; detail?: ToolError['detail'] } },
) {
  if ('error' in outcome) {
    throw new ToolError(outcome.error.code, outcome.error.message, outcome.error.detail);
  }

  return outcome.ok;
}

export async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** One frame's content script over happy-dom, with a fake worker. */
export function setup({ visible = false } = {}) {
  const worker = {
    visible: vi.fn(() => Promise.resolve(visible)),
    stop: vi.fn(() => Promise.resolve()),
    identify: vi.fn(() => Promise.resolve({ frameId: 0, key: 'secret' })),
  };

  const { handlers, indicator } = createContent({ top: true, worker });

  cleanups.push(() => indicator()?.set({ visible: false }));

  const snapshot = async (input: Partial<SnapshotInput> = {}) =>
    unwrap(
      await handlers['page.snapshot']({
        frameId: 0,
        scope: 'page',
        max_chars: 30_000,
        base: 1,
        ...input,
      }),
    );

  const text = async (input: Partial<SnapshotInput> = {}) =>
    (await snapshot(input)).lines
      .map((line) => `${'  '.repeat(line.depth)}${line.text}`)
      .join('\n');

  const inspect = async (ref: string, doc?: string) =>
    unwrap(await handlers['page.inspect']({ ref, doc }));

  return { handlers, indicator, worker, snapshot, text, inspect };
}

export function refOf(text: string, label: string) {
  const ref = text
    .split('\n')
    .filter((entry) => entry.includes(label))
    .map((entry) => /\[(f\d+e\d+)\]/.exec(entry)?.[1])
    .find((found) => found !== undefined);

  if (!ref) throw new Error(`No ref for ${label} in:\n${text}`);

  return ref;
}

/** A fresh body and `chrome.dom.openOrClosedShadowRoot` that sees closed roots, per test. */
export function useContentDom() {
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
}
