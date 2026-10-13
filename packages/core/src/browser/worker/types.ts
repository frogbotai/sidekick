export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface CdpEvent {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

/** The debugger, per tab: `chrome.debugger` in the worker, a recording fake in tests. */
export interface Cdp {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
  attachedTabs(): Promise<number[]>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  onDetach(listener: (tabId: number, reason: string) => void): () => void;
}

export interface TabInfo {
  id: number;
  windowId: number;
  groupId: number;
  url: string;
  pendingUrl?: string;
  title: string;
  active: boolean;
}

export interface FrameInfo {
  frameId: number;
  parentFrameId: number;
  url: string;
}

export interface Capture extends Size {
  data: string;
  mime: string;
}

/** The parts of `chrome.tabs`, `tabGroups`, `windows` and `webNavigation` the worker uses. */
export interface Tabs {
  get(tabId: number): Promise<TabInfo>;
  inGroup(groupId: number): Promise<TabInfo[]>;
  create(input: { windowId: number; url: string; active: boolean }): Promise<TabInfo>;
  group(tabId: number, groupId?: number): Promise<number>;
  label(groupId: number, title: string): Promise<void>;
  activate(tabId: number): Promise<void>;
  navigate(tabId: number, url: string): Promise<void>;
  history(tabId: number, go: 'back' | 'forward' | 'reload'): Promise<void>;
  close(tabId: number): Promise<void>;
  frames(tabId: number): Promise<FrameInfo[]>;
  waitForLoad(tabId: number, timeout: number): Promise<boolean>;
  captureVisible(windowId: number, scale: number): Promise<Capture>;
  /** A page in `sourceTabId` opened tab `id` (a link with a target, `window.open`); not a tab the user opened. */
  onOpened(listener: (tab: { id: number; sourceTabId: number }) => void): () => void;
  onGroupRemoved(listener: (groupId: number) => void): () => void;
}

/** A ref's frame and what it needs before acting. */
export interface RefInfo {
  frameId: number;
  frameOrigin: string;
  redacted: boolean;
  /** The field's `maxlength`, when the browser enforces one. */
  max_length?: number;
}

/** A ref scrolled into view: `point` and `rect` are in top-level viewport CSS pixels. */
export interface Target {
  point: Point;
  rect: Rect;
  in_view: boolean;
  obscured_by?: string;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface ScrollStart {
  token: string;
  container: string;
  point: Point;
  delta: Point;
}

export interface ScrollEnd {
  moved: number;
  at_end: boolean;
}

export interface Snapshot {
  title: string;
  text: string;
  redacted: number;
  truncated: boolean;
}

/**
 * The content scripts, addressed per tab; refs name their frame. Methods throw `ToolError`
 * (`stale_ref`, `unsupported_page`) when the page can't answer.
 */
export interface Page {
  /** A secret per worker that child frames give when they announce their frame id to their parent. */
  readonly key: string;
  snapshot(
    tabId: number,
    input: { scope: 'viewport' | 'page'; ref?: string; max_chars: number },
  ): Promise<Snapshot>;
  inspect(tabId: number, ref: string): Promise<RefInfo>;
  scrollTo(tabId: number, ref: string): Promise<Target>;
  focus(tabId: number, ref: string): Promise<void>;
  selectContents(tabId: number, ref: string): Promise<void>;
  readValue(tabId: number, ref: string): Promise<string>;
  selectOptions(tabId: number, ref: string, values: string[]): Promise<string[]>;
  scrollStart(
    tabId: number,
    input: { ref?: string; direction: Direction; amount?: number },
  ): Promise<ScrollStart | null>;
  scrollEnd(tabId: number, token: string): Promise<ScrollEnd>;
  scrollFallback(tabId: number, token: string): Promise<ScrollEnd>;
  domQuiet(tabId: number, input: { quiet: number; cap: number }): Promise<boolean>;
  viewport(tabId: number): Promise<Size>;
  iframes(tabId: number): Promise<{ frameId: number; sources: string[] }[]>;
  strip(
    tabId: number,
    frameId: number,
    input: { reported: string[]; surplus: number },
  ): Promise<string[]>;
  indicator(tabId: number, state: { visible?: boolean; cursor?: Point }): Promise<void>;
}
