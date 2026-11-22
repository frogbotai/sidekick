import type { PermissionAction, ToolContext, ToolMetadata, ToolResult } from '../../tool/tool';
import { ToolError, UNTRUSTED } from '../../tool/tool';
import { originOf } from '../../tool/url';
import { checkpoint, race, stopped } from './abort';
import type { Challenge } from './challenge';
import { detect } from './detect';
import type { Recordings } from './recordings';
import type { Run, Runs } from './runs';
import type { Sessions } from './sessions';
import type { Settler } from './settle';
import type { Cdp, Images, Page, Point, Rect, RefInfo, Size, TabInfo, Tabs } from './types';
import type { Videos } from './videos';

/** Screenshot pixels to viewport CSS pixels for one tab (271 D3). */
export interface ScreenMap {
  offset: Point;
  scale: Point;
  /** The screenshot's size in its own pixels, which a `region` must fall inside. */
  image: Size;
  /** The tab's `documents` count when the capture started; x/y fail `stale_screenshot` once it moves on. */
  document: number;
}

export interface BrowserEnv {
  cdp: Cdp;
  page: Page;
  tabs: Tabs;
  images: Images;
  sessions: Sessions;
  settler: Settler;
  runs: Runs;
  /** The person's demonstrations, one per tab (sidekick-21). */
  recordings: Recordings;
  /** Tab video recordings, one per tab (sidekick-19). */
  videos: Videos;
  screens: Map<number, ScreenMap>;
  /** New-document commits per tab, so a call can tell its page was replaced. */
  documents: Map<number, number>;
  mac: boolean;
}

export interface Act {
  env: BrowserEnv;
  ctx: ToolContext;
  run: Run;
  signal: AbortSignal;
  tabId: number;
  tab: TabInfo;
  origin: string;
  action: PermissionAction;
  /** What the call has reported so far, as `report` merges it. */
  metadata: ToolMetadata;
}

export function notInGroup(tabId: number) {
  return new ToolError(
    'not_in_group',
    `Tab ${tabId} isn’t in this task’s tab group. Use tabs_list, or tabs_open to open one.`,
  );
}

export async function getTab(env: BrowserEnv, tabId: number, signal: AbortSignal) {
  try {
    return await race(env.tabs.get(tabId), signal);
  } catch (error) {
    if (error instanceof ToolError) throw error;

    throw new ToolError('invalid_target', `Tab ${tabId} doesn’t exist. Use tabs_list.`);
  }
}

export function runOf(env: BrowserEnv, ctx: ToolContext) {
  const run = ctx.run && env.runs.get(ctx.run.id);

  if (!run) throw stopped();

  const signal = AbortSignal.any([ctx.signal, run.signal]);

  checkpoint(signal);

  return { run, signal };
}

export async function enter(
  env: BrowserEnv,
  ctx: ToolContext,
  tabId: number,
  action: PermissionAction,
  resource?: string,
): Promise<Act> {
  const { run, signal } = runOf(env, ctx);
  const tab = await getTab(env, tabId, signal);

  if (!env.runs.owns(run, tab)) throw notInGroup(tabId);

  const origin = originOf(tab.url);

  await race(ctx.permission.assert({ action, resource: resource ?? origin }), signal);

  const act: Act = { env, ctx, run, signal, tabId, tab, origin, action, metadata: {} };

  await recheck(act);

  return act;
}

export async function inspect(act: Act, ref: string): Promise<RefInfo> {
  const info = await race(act.env.page.inspect(act.tabId, ref), act.signal);

  if (info.frameOrigin !== act.origin) {
    await race(
      act.ctx.permission.assert({
        action: act.action,
        resource: act.origin,
        frameOrigin: info.frameOrigin,
      }),
      act.signal,
    );
  }

  return info;
}

const NAME_LIMIT = 40;

/** An element as a status line names it: its role and accessible name, like `button “Sign in”`. */
export function targetName({ role, name }: Pick<RefInfo, 'role' | 'name'>) {
  const label = name.replace(/\s+/g, ' ').trim();
  const short = label.length > NAME_LIMIT ? `${label.slice(0, NAME_LIMIT).trimEnd()}…` : label;
  const kind = role || 'element';

  return short ? `${kind} “${short}”` : kind;
}

/** Adds `metadata` to what the call reports as its progress; a lost report never fails the call. */
export async function report(act: Act, metadata: ToolMetadata) {
  act.metadata = { ...act.metadata, ...metadata };

  await act.ctx.progress?.(act.metadata).catch(() => undefined);
}

/** `inspect`, then reports the element as `key` (`target` unless given). */
export async function inspectTarget(act: Act, ref: string, key = 'target') {
  const info = await inspect(act, ref);

  await report(act, { [key]: targetName(info) });

  return info;
}

/** The focused field for `fill` without a ref: `not_editable` when nothing editable has focus. */
export async function focusedField(act: Act) {
  const field = await race(act.env.page.focused(act.tabId), act.signal);

  if (!field.editable) {
    throw new ToolError(
      'not_editable',
      'Nothing editable has focus. Click the field first, or fill by ref.',
      field.role && field.frameOrigin === act.origin ? { focused: targetName(field) } : undefined,
    );
  }

  if (field.frameOrigin !== act.origin) {
    await race(
      act.ctx.permission.assert({
        action: act.action,
        resource: act.origin,
        frameOrigin: field.frameOrigin,
      }),
      act.signal,
    );
  }

  await report(act, { target: targetName(field) });

  return field;
}

export async function recheck(act: Act) {
  const tab = await getTab(act.env, act.tabId, act.signal);

  if (!act.env.runs.owns(act.run, tab)) throw notInGroup(act.tabId);

  const moved = [tab.url, tab.pendingUrl].some((url) => url && originOf(url) !== act.origin);

  if (moved) {
    throw new ToolError(
      'navigated',
      'The tab moved to another site. Take a new snapshot before acting.',
      {
        url: tab.pendingUrl ?? tab.url,
      },
    );
  }
}

export function send(act: Act, method: string, params?: Record<string, unknown>) {
  return act.env.sessions.send(act.tabId, method, params, act.signal);
}

export async function scrollIntoView(act: Act, ref: string) {
  const target = await race(act.env.page.scrollTo(act.tabId, ref), act.signal);

  if (target.in_view) return target.point;

  if (target.obscured_by) {
    throw new ToolError(
      'obscured',
      `${ref} is covered by ${target.obscured_by}. Close or scroll past it, then retry.`,
      {
        obscured_by: target.obscured_by,
      },
    );
  }

  throw new ToolError('not_visible', `${ref} isn’t visible. Take a new snapshot.`);
}

export function documentOf(env: BrowserEnv, tabId: number) {
  return env.documents.get(tabId) ?? 0;
}

function current(env: BrowserEnv, tabId: number, map: ScreenMap) {
  if (map.document < documentOf(env, tabId)) {
    throw new ToolError(
      'stale_screenshot',
      'The page changed since the last screenshot. Take a new one.',
    );
  }

  return map;
}

export function fromScreenshot(env: BrowserEnv, tabId: number, point: Point): Point {
  const found = env.screens.get(tabId);

  if (!found) return point;

  const map = current(env, tabId, found);
  const { width, height } = map.image;

  if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
    throw new ToolError(
      'invalid_target',
      `(${point.x}, ${point.y}) is outside your last screenshot, which is ${width}×${height}. Pick a point inside it.`,
    );
  }

  return { x: map.offset.x + point.x * map.scale.x, y: map.offset.y + point.y * map.scale.y };
}

/** A region of the tab's last screenshot, cut to the image, in viewport CSS pixels. */
export function fromScreenshotRect(env: BrowserEnv, tabId: number, region: Rect): Rect {
  const found = env.screens.get(tabId);

  if (!found) {
    throw new ToolError(
      'stale_screenshot',
      'A region is in pixels of your last screenshot. Take a screenshot first.',
    );
  }

  const map = current(env, tabId, found);
  const left = Math.max(0, region.x);
  const top = Math.max(0, region.y);
  const right = Math.min(map.image.width, region.x + region.width);
  const bottom = Math.min(map.image.height, region.y + region.height);

  if (region.width <= 0 || region.height <= 0 || right <= left || bottom <= top) {
    throw new ToolError(
      'invalid_target',
      `The region is outside your last screenshot, which is ${map.image.width}×${map.image.height}. Pick an area inside it.`,
    );
  }

  return {
    x: map.offset.x + left * map.scale.x,
    y: map.offset.y + top * map.scale.y,
    width: (right - left) * map.scale.x,
    height: (bottom - top) * map.scale.y,
  };
}

export function screenMap(clip: Point & Size, image: Size, document: number): ScreenMap {
  return {
    offset: { x: clip.x, y: clip.y },
    scale: { x: clip.width / image.width, y: clip.height / image.height },
    image: { width: image.width, height: image.height },
    document,
  };
}

/** Resolves a pointer target, by ref or screenshot pixels, through req. 13's checks up to the hit-test. */
export async function aim(
  act: Act,
  input: { ref?: string; x?: number; y?: number },
): Promise<Point> {
  if (input.ref !== undefined) {
    await inspectTarget(act, input.ref);
    await recheck(act);
    await act.env.sessions.ensure(act.tabId, act.signal);

    return scrollIntoView(act, input.ref);
  }

  if (input.x === undefined || input.y === undefined) {
    throw new ToolError(
      'invalid_target',
      'Give a ref from the snapshot, or x and y from the last screenshot.',
    );
  }

  await recheck(act);
  await act.env.sessions.ensure(act.tabId, act.signal);

  return offStop(act, fromScreenshot(act.env, act.tabId, { x: input.x, y: input.y }));
}

/** Refuses a screenshot point on Sidekick's Stop button; a frame that can't answer has no Stop. */
export async function offStop(act: Act, point: Point): Promise<Point> {
  const onStop = await race(act.env.page.stopAt(act.tabId, point), act.signal).catch(
    (error: unknown) => {
      if (act.signal.aborted) throw error;

      return false;
    },
  );

  if (onStop) {
    throw new ToolError(
      'invalid_target',
      'That point is Sidekick’s Stop button, not the page. Pick a point on the page.',
    );
  }

  return point;
}

export async function cursor(act: Act, point: Point) {
  await act.env.page.indicator(act.tabId, { cursor: point }).catch(() => undefined);
}

export interface ActionOutput {
  url: string;
  navigated: boolean;
  settled: boolean;
  /** Only when the action ended on a captcha, bot check or block page. */
  challenge?: Challenge;
}

/** The action's result, after checking whether it ended on a wall (D2). */
export async function finish(act: Act, settled: boolean): Promise<ActionOutput> {
  const landed = await getTab(act.env, act.tabId, act.signal);
  const challenge = await detect(act.env, act.tabId, landed.url, act.signal);
  const tab = challenge ? await getTab(act.env, act.tabId, act.signal) : landed;
  const output = { url: tab.url, navigated: tab.url !== act.tab.url, settled };

  return challenge ? { ...output, challenge } : output;
}

export function untrusted<O>(output: O, content: ToolResult['content'] = []): ToolResult<O> {
  return { output, content: [{ type: 'text', text: UNTRUSTED }, ...content] };
}
