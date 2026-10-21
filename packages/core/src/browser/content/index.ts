import { contentProtocol, type frameProtocol } from '../../protocol';
import { callWorker } from '../../rpc/content';
import type { Handlers } from '../../rpc/define';
import { ToolError, type ToolErrorCode, type ToolErrorDetail } from '../../tool/tool';
import { assignFrames, type Identify, listenForFrames } from './dom';
import { focusElement, maxLengthOf, readValue, selectContents, selectOptions } from './fields';
import { frameSources, stripFrames } from './frames';
import { createIndicator, type Indicator } from './indicator';
import { domQuiet } from './quiet';
import { createRefs, removed } from './refs';
import { fingerprintOf, isRedacted } from './roles';
import { frameBox, scrollBegin, scrollFallback, scrollFinish, scrollToElement } from './scroll';
import { snapshotFrame } from './snapshot';

export type PageHandlers = Omit<Handlers<(typeof frameProtocol)['methods']>, 'frame.ping'>;

type Outcome<T> =
  { ok: T } | { error: { code: ToolErrorCode; message: string; detail?: ToolErrorDetail } };

async function guard<T>(run: () => T | Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await run() };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;

    return { error: { code: error.code, message: error.message, detail: error.detail } };
  }
}

export interface ContentOptions {
  /** Whether this frame shows the indicator: the top frame only. */
  top?: boolean;
  /** Asks the worker whether this tab is in a run and which frame this is, and tells it about a trusted Stop. */
  worker?: {
    visible: () => Promise<boolean>;
    stop: () => Promise<void>;
    identify: Identify;
  };
}

const chromeWorker: NonNullable<ContentOptions['worker']> = {
  visible: async () => (await callWorker(contentProtocol, 'indicator.state', {})).visible,
  stop: async () => void (await callWorker(contentProtocol, 'indicator.stop', {})),
  identify: () => callWorker(contentProtocol, 'frame.identify', {}),
};

/** The content script's answers to the worker for one frame's document (req. 9–12, 16–17, 23). */
export function createContent({
  top = window === window.top,
  worker = chromeWorker,
}: ContentOptions = {}) {
  const doc = crypto.randomUUID();
  let frameId = 0;
  const refs = createRefs(() => frameId);
  let indicator: Indicator | undefined;

  listenForFrames(worker.identify);

  const resolve = (ref: string, expected?: string) => {
    if (expected !== undefined && expected !== doc) throw removed(ref);

    return refs.resolve(ref);
  };

  const showIndicator = () => {
    indicator ??= createIndicator(() => void worker.stop().catch(() => undefined));

    return indicator;
  };

  if (top) {
    void worker
      .visible()
      .then((visible) => visible && showIndicator().set({ visible: true }))
      .catch(() => undefined);
  }

  const handlers: PageHandlers = {
    'page.snapshot': (input) =>
      guard(async () => {
        frameId = input.frameId;

        if (input.children) await assignFrames(input.children, { key: input.key, wait: true });

        const root = input.ref === undefined ? undefined : resolve(input.ref, input.doc);
        const snapshot = snapshotFrame({
          refs,
          scope: input.scope,
          root,
          maxChars: input.max_chars,
        });

        return { ...snapshot, doc };
      }),
    'page.inspect': ({ ref, doc: expected }) =>
      guard(() => {
        const element = resolve(ref, expected);
        const max = maxLengthOf(element);
        const { role, name } = fingerprintOf(element);

        return {
          frameOrigin: location.origin,
          redacted: isRedacted(element),
          role,
          name,
          ...(max === undefined ? {} : { max_length: max }),
        };
      }),
    'page.scrollTo': ({ ref, doc: expected }) =>
      guard(() => scrollToElement(resolve(ref, expected))),
    'page.frameBox': ({ frameId: child, reveal, point, children, key }) =>
      guard(async () => {
        if (children) await assignFrames(children, { key });

        return frameBox(child, reveal, point);
      }),
    'page.focus': ({ ref, doc: expected }) =>
      guard(() => {
        focusElement(resolve(ref, expected));

        return null;
      }),
    'page.selectContents': ({ ref, doc: expected }) =>
      guard(() => {
        selectContents(resolve(ref, expected), ref);

        return null;
      }),
    'page.readValue': ({ ref, doc: expected }) =>
      guard(() => readValue(resolve(ref, expected), ref)),
    'page.selectOptions': ({ ref, doc: expected, values }) =>
      guard(() => selectOptions(resolve(ref, expected), ref, values)),
    'page.scrollStart': ({ ref, doc: expected, point, direction, amount, children, key }) =>
      guard(async () => {
        if (children) await assignFrames(children, { key });

        return scrollBegin({
          element: ref === undefined ? undefined : resolve(ref, expected),
          point,
          direction,
          amount,
        });
      }),
    'page.scrollEnd': ({ token }) => guard(() => scrollFinish(token)),
    'page.scrollFallback': ({ token }) => guard(() => scrollFallback(token)),
    'page.domQuiet': ({ quiet, cap }) => guard(() => domQuiet(quiet, cap)),
    'page.viewport': () => guard(() => ({ width: innerWidth, height: innerHeight })),
    'page.iframes': () => guard(frameSources),
    'page.strip': ({ reported, surplus }) => guard(() => stripFrames(reported, surplus)),
    'page.indicator': (state) =>
      guard(() => {
        if (top && (state.visible === true || indicator)) showIndicator().set(state);

        return null;
      }),
  };

  return { handlers, indicator: () => indicator };
}
