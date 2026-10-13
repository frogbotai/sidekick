import { ToolError } from '../../tool/tool';
import type { Direction, Point, Rect, ScrollEnd } from '../worker/types';
import {
  centre,
  contains,
  contentOrigin,
  describe,
  type FrameElement,
  frameElements,
  frameIdOf,
  hitTest,
  isFrame,
  nextFrame,
  parentAcross,
  stable,
  toRect,
  visiblePart,
} from './dom';

const ALIGNMENTS = ['center', 'end', 'start'] as const;

const SCROLL_START_MS = 250;

const SCROLL_CAP_MS = 2_000;

const SCREEN_SHARE = 0.8;

export interface ScrollTarget {
  point: Point;
  rect: Rect;
  in_view: boolean;
  obscured_by?: string;
}

function rectKey(element: Element) {
  const rect = element.getBoundingClientRect();

  return `${rect.left},${rect.top},${rect.width},${rect.height}`;
}

/** Playwright's alignment cycle: scroll to `center`, `end`, then `start`, hit-testing once stable. */
export async function scrollToElement(element: Element): Promise<ScrollTarget> {
  let last: ScrollTarget | undefined;

  for (const block of ALIGNMENTS) {
    element.scrollIntoView({
      block,
      inline: block === 'center' ? 'center' : 'nearest',
      behavior: 'instant',
    });

    await stable(() => rectKey(element));

    const rect = toRect(element.getBoundingClientRect());
    const visible = visiblePart(rect);

    if (!visible) {
      last = { point: centre(rect), rect, in_view: false };
      continue;
    }

    const point = centre(visible);
    const hit = hitTest(point);

    if (hit && contains(element, hit)) return { point, rect, in_view: true };

    last = { point, rect, in_view: false, obscured_by: hit ? describe(hit) : undefined };
  }

  return (
    last ?? { point: { x: 0, y: 0 }, rect: toRect(element.getBoundingClientRect()), in_view: false }
  );
}

export function frameElementFor(frameId: number): FrameElement {
  const found = frameElements().find((element) => frameIdOf(element) === frameId);

  if (!found) {
    throw new ToolError('not_visible', 'That frame is no longer on the page. Take a new snapshot.');
  }

  return found;
}

/** A child frame's offset in this frame; with `point` (child coordinates), what covers it here. */
export async function frameBox(frameId: number, reveal: boolean, point?: Point) {
  const element = frameElementFor(frameId);

  if (reveal) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await stable(() => rectKey(element));
  }

  const origin = contentOrigin(element);

  if (!point) return { origin };

  const hit = hitTest({ x: origin.x + point.x, y: origin.y + point.y });

  return { origin, obscured_by: !hit || hit === element ? undefined : describe(hit) };
}

function deltaOf(direction: Direction, amount: number): Point {
  switch (direction) {
    case 'up':
      return { x: 0, y: -amount };
    case 'down':
      return { x: 0, y: amount };
    case 'left':
      return { x: -amount, y: 0 };
    case 'right':
      return { x: amount, y: 0 };
  }
}

function canScroll(element: Element, vertical: boolean) {
  if (element === document.scrollingElement) return true;

  const style = getComputedStyle(element);
  const overflow = vertical ? style.overflowY : style.overflowX;

  if (!/(auto|scroll|overlay)/.test(overflow)) return false;

  return vertical
    ? element.scrollHeight > element.clientHeight
    : element.scrollWidth > element.clientWidth;
}

/** The spike's direction test: can this element still move that way? */
export function canMove(element: Element, delta: Point) {
  if (delta.y > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1;

  if (delta.y < 0) return element.scrollTop > 0;

  if (delta.x > 0) return element.scrollLeft + element.clientWidth < element.scrollWidth - 1;

  return element.scrollLeft > 0;
}

/** The first ancestor of `start` (the document last) that can move in `direction`. */
export function scrollerFor(start: Element | null, direction: Direction): Element | undefined {
  const vertical = direction === 'up' || direction === 'down';
  const probe = deltaOf(direction, 1);

  for (let element = start; element; element = parentAcross(element)) {
    if (element === document.body) continue;

    if (canScroll(element, vertical) && canMove(element, probe)) return element;
  }

  const root = document.scrollingElement;

  return root && canMove(root, probe) ? root : undefined;
}

function viewportOf(element: Element): Rect | undefined {
  if (element === document.scrollingElement) {
    return { x: 0, y: 0, width: innerWidth, height: innerHeight };
  }

  return visiblePart(toRect(element.getBoundingClientRect()));
}

const GRID = [
  [0.5, 0.5],
  [0.5, 0.35],
  [0.5, 0.65],
  [0.35, 0.5],
  [0.65, 0.5],
] as const;

function wheelPoint(container: Element, area: Rect, direction: Direction): Point {
  for (const [fx, fy] of GRID) {
    const point = { x: area.x + area.width * fx, y: area.y + area.height * fy };

    if (scrollerFor(hitTest(point), direction) === container) return point;
  }

  return centre(area);
}

interface Pending {
  container: Element;
  delta: Point;
  top: number;
  left: number;
}

const pending = new Map<string, Pending>();

export interface ScrollBegin {
  start: { token: string; container: string; point: Point; delta: Point } | null;
  descend?: { frameId: number; point: Point };
}

export function scrollBegin(input: {
  element?: Element;
  point?: Point;
  direction: Direction;
  amount?: number;
}): ScrollBegin {
  const point = input.point ?? { x: innerWidth / 2, y: innerHeight / 2 };
  const target = input.element ?? hitTest(point);
  let descend: ScrollBegin['descend'];

  if (!input.element && isFrame(target)) {
    const frameId = frameIdOf(target);
    const origin = contentOrigin(target);

    if (frameId !== undefined) {
      descend = { frameId, point: { x: point.x - origin.x, y: point.y - origin.y } };
    }
  }

  const container = scrollerFor(target, input.direction);
  const area = container && viewportOf(container);

  if (!container || !area) return { start: null, descend };

  const vertical = input.direction === 'up' || input.direction === 'down';
  const extent = vertical ? area.height : area.width;
  const delta = deltaOf(input.direction, Math.round(input.amount ?? extent * SCREEN_SHARE));
  const token = crypto.randomUUID();

  pending.clear();
  pending.set(token, { container, delta, top: container.scrollTop, left: container.scrollLeft });

  return {
    start: {
      token,
      container: describe(container),
      point: wheelPoint(container, area, input.direction),
      delta,
    },
    descend,
  };
}

async function settle(container: Element) {
  await new Promise<void>((resolve) => {
    let moving = false;

    const target: EventTarget = container === document.scrollingElement ? document : container;

    const finish = () => {
      target.removeEventListener('scroll', onScroll, true);
      target.removeEventListener('scrollend', finish, true);
      clearTimeout(early);
      clearTimeout(cap);
      resolve();
    };

    const onScroll = () => {
      moving = true;
    };

    const early = setTimeout(() => {
      if (!moving) finish();
    }, SCROLL_START_MS);

    const cap = setTimeout(finish, SCROLL_CAP_MS);

    target.addEventListener('scroll', onScroll, { capture: true, passive: true });
    target.addEventListener('scrollend', finish, true);
  });

  await stable(() => `${container.scrollTop},${container.scrollLeft}`);
}

function take(token: string) {
  const entry = pending.get(token);

  if (!entry) {
    throw new ToolError('timeout', 'The page reloaded during the scroll. Scroll again.');
  }

  return entry;
}

function measure({ container, delta, top, left }: Pending): ScrollEnd {
  const moved = Math.round(
    Math.abs(delta.y !== 0 ? container.scrollTop - top : container.scrollLeft - left),
  );

  return { moved, at_end: !canMove(container, delta) };
}

export async function scrollFinish(token: string): Promise<ScrollEnd> {
  const entry = take(token);

  await settle(entry.container);

  return measure(entry);
}

/** `scrollBy` when the wheel moved nothing, or there is no debugger. */
export async function scrollFallback(token: string): Promise<ScrollEnd> {
  const entry = take(token);

  pending.delete(token);
  entry.container.scrollBy({ top: entry.delta.y, left: entry.delta.x, behavior: 'instant' });
  await nextFrame();
  await settle(entry.container);

  return measure(entry);
}
