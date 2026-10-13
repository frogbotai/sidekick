import type { Point, Rect } from '../worker/types';

const own = new WeakSet<Element>();

/** Marks Sidekick's own element, which snapshots, hit-tests and walks skip. */
export function markOwn(element: Element) {
  own.add(element);
}

export function isOwn(element: Element) {
  return own.has(element);
}

export function shadowOf(element: Element): ShadowRoot | null {
  if (isOwn(element)) return null;

  if (element.shadowRoot) return element.shadowRoot;

  if (!(element instanceof HTMLElement)) return null;

  try {
    return chrome.dom.openOrClosedShadowRoot(element);
  } catch {
    return null;
  }
}

export function parentAcross(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  const root = element.getRootNode();

  return root instanceof ShadowRoot ? root.host : null;
}

export function contains(outer: Element, inner: Element | null) {
  for (let element = inner; element; element = parentAcross(element)) {
    if (element === outer) return true;
  }

  return false;
}

function topmost(root: Document | ShadowRoot, { x, y }: Point) {
  return root.elementsFromPoint(x, y).find((element) => !isOwn(element)) ?? null;
}

/** The element under a point, through open and closed shadow roots, ignoring Sidekick's indicator. */
export function hitTest(point: Point): Element | null {
  let element = topmost(document, point);

  while (element) {
    const root = shadowOf(element);
    const inner = root ? topmost(root, point) : null;

    if (!inner || inner === element) break;

    element = inner;
  }

  return element;
}

export function deepActiveElement(): Element | null {
  let element = document.activeElement;

  while (element) {
    const inner = shadowOf(element)?.activeElement;

    if (!inner) break;

    element = inner;
  }

  return element;
}

export function describe(element: Element): string {
  if (element === document.scrollingElement) return 'document';

  const id = element.id ? `#${element.id}` : '';
  const classes = typeof element.className === 'string' ? element.className.trim() : '';
  const names = classes ? `.${classes.split(/\s+/).slice(0, 2).join('.')}` : '';
  const role = element.getAttribute('role');

  return `${element.tagName.toLowerCase()}${id}${names}${role ? `[role=${role}]` : ''}`.slice(
    0,
    80,
  );
}

export type FrameElement = HTMLIFrameElement | HTMLFrameElement;

export function isFrame(element: Element | null): element is FrameElement {
  return element instanceof HTMLIFrameElement || element?.tagName.toUpperCase() === 'FRAME';
}

/** Every `<iframe>` and `<frame>`, inside open and closed shadow roots too. */
export function frameElements(): FrameElement[] {
  const found: FrameElement[] = [];

  const visit = (root: Document | ShadowRoot) => {
    for (const element of root.querySelectorAll('*')) {
      if (isFrame(element)) found.push(element);

      const shadow = shadowOf(element);

      if (shadow) visit(shadow);
    }
  };

  visit(document);

  return found;
}

/** A child frame of this frame, as `webNavigation` reports it to the worker. */
export interface ChildFrame {
  frameId: number;
  url: string;
}

const frameIds = new WeakMap<FrameElement, number>();

const ANNOUNCE = 'sidekickFrame';

const ASK = 'sidekickAsk';

const ANNOUNCE_WAIT_MS = 200;

const announced = new WeakMap<object, { key: string; frameId: number }>();

const heard = new Set<() => void>();

function announcement(data: unknown) {
  if (typeof data !== 'object' || data === null) return undefined;

  const key: unknown = Reflect.get(data, ANNOUNCE);
  const frameId: unknown = Reflect.get(data, 'frameId');

  return typeof key === 'string' && typeof frameId === 'number' ? { key, frameId } : undefined;
}

function asked(data: unknown) {
  return typeof data === 'object' && data !== null && Reflect.get(data, ASK) === true;
}

/** This frame's id and the worker's key, from the worker, which reads the id from `sender.frameId`. */
export type Identify = () => Promise<{ frameId: number; key: string }>;

/**
 * Hears child frames' content scripts name their frame id, and answers the parent frame's
 * content script when it asks for this frame's. Registered at `document_start`, so it runs before
 * the page's listeners and keeps both messages from them. `document.open` erases the window's
 * listeners, so it registers again when the document's root is replaced.
 */
export function listenForFrames(identify: Identify) {
  let identity: ReturnType<Identify> | undefined;

  const onMessage = (event: MessageEvent) => {
    if (asked(event.data) && event.source === window.parent && window.parent !== window) {
      event.stopImmediatePropagation();
      identity ??= identify();

      identity.then(
        ({ frameId, key }) => window.parent.postMessage({ [ANNOUNCE]: key, frameId }, '*'),
        () => (identity = undefined),
      );

      return;
    }

    const found = announcement(event.data);

    if (!found || !event.source) return;

    event.stopImmediatePropagation();
    announced.set(event.source, found);

    for (const wake of heard) wake();
  };

  const listen = () => {
    removeEventListener('message', onMessage, true);
    addEventListener('message', onMessage, true);
  };

  listen();
  new MutationObserver(listen).observe(document, { childList: true });
}

function announcedId(element: FrameElement, key: string | undefined) {
  const child = element.contentWindow;
  const found = child && key !== undefined ? announced.get(child) : undefined;

  return found?.key === key ? found?.frameId : undefined;
}

function untilAnnounced(elements: FrameElement[], key: string) {
  for (const element of elements) element.contentWindow?.postMessage({ [ASK]: true }, '*');

  const done = () =>
    elements.every((element) => !element.contentWindow || announcedId(element, key) !== undefined);

  if (done()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      heard.delete(check);
      resolve();
    };

    const check = () => done() && finish();
    const timer = setTimeout(finish, ANNOUNCE_WAIT_MS);

    heard.add(check);
  });
}

function withoutHash(url: string) {
  return url.split('#')[0] ?? url;
}

/** A frame another extension put on the page. */
export function foreignExtension(source: string) {
  return (
    source.startsWith('chrome-extension://') &&
    !source.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  );
}

export interface AssignOptions {
  /** The worker's key, which each child gave when it announced its frame id. */
  key?: string;
  /** Asks the children for their frame ids and waits briefly for the answers. */
  wait?: boolean;
}

/**
 * Matches this frame's frame elements to frame ids. A child that announced its frame id is matched
 * exactly, even when `webNavigation` left it out of `children` (it can omit subframes); the rest
 * match the reported children by URL, URL without the hash, then document order. Other
 * extensions' frames are never reported, so those are left out.
 */
export async function assignFrames(
  children: ChildFrame[],
  { key, wait = false }: AssignOptions = {},
) {
  const elements = frameElements().filter((element) => !foreignExtension(frameSource(element)));

  if (wait && key !== undefined) await untilAnnounced(elements, key);

  const free = new Map(children.map((child) => [child.frameId, child]));
  const taken = new Set<FrameElement>();

  const take = (element: FrameElement, child: ChildFrame) => {
    frameIds.set(element, child.frameId);
    free.delete(child.frameId);
    taken.add(element);
  };

  for (const element of elements) {
    const id = announcedId(element, key);

    if (id !== undefined) take(element, free.get(id) ?? { frameId: id, url: '' });
  }

  for (const same of [
    (a: string, b: string) => a === b,
    (a: string, b: string) => withoutHash(a) === withoutHash(b),
  ]) {
    for (const element of elements) {
      if (taken.has(element)) continue;

      const source = frameSource(element);
      const child = [...free.values()].find((candidate) => same(candidate.url, source));

      if (child) take(element, child);
    }
  }

  const rest = [...free.values()];

  for (const element of elements) {
    if (taken.has(element)) continue;

    const child = rest.shift();

    if (child) take(element, child);
    else frameIds.delete(element);
  }
}

/** The child frame id `assignFrames` matched to a frame element, or `undefined`. */
export function frameIdOf(element: FrameElement): number | undefined {
  return frameIds.get(element);
}

export function frameSource(element: FrameElement) {
  if (element instanceof HTMLIFrameElement && element.srcdoc) return 'about:srcdoc';

  return element.src || 'about:blank';
}

/** Where a frame element's document starts, inside its border and padding. */
export function contentOrigin(element: FrameElement): Point {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);

  return {
    x: rect.left + element.clientLeft + (Number.parseFloat(style.paddingLeft) || 0),
    y: rect.top + element.clientTop + (Number.parseFloat(style.paddingTop) || 0),
  };
}

export function toRect(rect: DOMRect): Rect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** The part of a rect inside the viewport, or `undefined` when none is. */
export function visiblePart(rect: Rect): Rect | undefined {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(innerWidth, rect.x + rect.width);
  const bottom = Math.min(innerHeight, rect.y + rect.height);

  if (right <= left || bottom <= top) return undefined;

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

const STABLE_CAP_MS = 1_000;

/** Waits until `read` gives the same value two animation frames in a row (Playwright's stable check). */
export async function stable(read: () => string) {
  const started = performance.now();
  let last = read();
  let same = 0;

  while (same < 2 && performance.now() - started < STABLE_CAP_MS) {
    await nextFrame();

    const now = read();

    same = now === last ? same + 1 : 0;
    last = now;
  }
}
