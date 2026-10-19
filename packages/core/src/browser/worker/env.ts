import type { PermissionAction, ToolContext, ToolMetadata, ToolResult } from '../../tool/tool';
import { ToolError, UNTRUSTED } from '../../tool/tool';
import { originOf } from '../../tool/url';
import { checkpoint, race, stopped } from './abort';
import type { Run, Runs } from './runs';
import type { Sessions } from './sessions';
import type { Settler } from './settle';
import type { Cdp, Page, Point, RefInfo, Size, TabInfo, Tabs } from './types';

/** Screenshot pixels to viewport CSS pixels for one tab (271 D3). */
export interface ScreenMap {
  offset: Point;
  scale: Point;
}

export interface BrowserEnv {
  cdp: Cdp;
  page: Page;
  tabs: Tabs;
  sessions: Sessions;
  settler: Settler;
  runs: Runs;
  screens: Map<number, ScreenMap>;
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

export function fromScreenshot(env: BrowserEnv, tabId: number, point: Point): Point {
  const map = env.screens.get(tabId);

  if (!map) return point;

  return { x: map.offset.x + point.x * map.scale.x, y: map.offset.y + point.y * map.scale.y };
}

export function screenMap(clip: Point & Size, image: Size): ScreenMap {
  return {
    offset: { x: clip.x, y: clip.y },
    scale: { x: clip.width / image.width, y: clip.height / image.height },
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

  return fromScreenshot(act.env, act.tabId, { x: input.x, y: input.y });
}

export async function cursor(act: Act, point: Point) {
  await act.env.page.indicator(act.tabId, { cursor: point }).catch(() => undefined);
}

export interface ActionOutput {
  url: string;
  navigated: boolean;
  settled: boolean;
}

export async function finish(act: Act, settled: boolean): Promise<ActionOutput> {
  const tab = await getTab(act.env, act.tabId, act.signal);

  return { url: tab.url, navigated: tab.url !== act.tab.url, settled };
}

export function untrusted<O>(output: O, content: ToolResult['content'] = []): ToolResult<O> {
  return { output, content: [{ type: 'text', text: UNTRUSTED }, ...content] };
}
