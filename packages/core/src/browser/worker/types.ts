import type { Probe } from './challenge';

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

/** An image as 8-bit RGBA rows, as `ImageData` holds it. */
export interface Rgba extends Size {
  data: Uint8ClampedArray;
}

/** Captures to pixels and pixels to PNG: `createImageBitmap` and `OffscreenCanvas` in the worker. */
export interface Images {
  decode(capture: Capture): Promise<Rgba>;
  /** The image as a base64 PNG. */
  png(image: Rgba): Promise<string>;
}

/** A finished recording, handed to the person as a download. */
export interface SavedVideo extends Size {
  file: string;
  /** The video codec, `avc` (H.264) unless the browser can't encode it. */
  codec: string;
  bytes: number;
}

/**
 * Turns a recording's JPEG frames into an MP4 and downloads it: an offscreen document with
 * WebCodecs and `chrome.downloads` in the extension, a fake in tests.
 */
export interface Encoder {
  open(id: string, input: { frameRate: number }): Promise<void>;
  /** One frame, shown from `timestamp` for `duration` seconds; frames come in timestamp order. */
  frame(id: string, frame: { data: string; timestamp: number; duration: number }): Promise<void>;
  /** Finishes the file and downloads it as `file`. */
  close(id: string, file: string): Promise<SavedVideo>;
  /** Drops the recording without saving it. */
  cancel(id: string): Promise<void>;
}

/** A tab's main frame committed: a new document, or a same-document `#` or history step. */
export interface Commit {
  tabId: number;
  url: string;
  sameDocument: boolean;
}

/** The parts of `chrome.tabs`, `tabGroups`, `windows`, `webNavigation` and `action` the worker uses. */
export interface Tabs {
  get(tabId: number): Promise<TabInfo>;
  /** The active tab of a window, for a chat's first browser call (278 D1). */
  active(windowId: number): Promise<TabInfo>;
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
  /** The window's visible tab as a JPEG resized to `size`; `source` crops it first, in fractions of the tab (0 to 1). */
  captureVisible(windowId: number, size: Size, source?: Rect): Promise<Capture>;
  /** A page in `sourceTabId` opened tab `id` (a link with a target, `window.open`); not a tab the user opened. */
  onOpened(listener: (tab: { id: number; sourceTabId: number }) => void): () => void;
  onGroupRemoved(listener: (groupId: number) => void): () => void;
  /** Main-frame commits only (`webNavigation`, `frameId` 0). */
  onCommitted(listener: (commit: Commit) => void): () => void;
  /** Main-frame navigation errors only, with Chrome's text, like `net::ERR_NAME_NOT_RESOLVED`. */
  onNavigationError(listener: (failure: { tabId: number; error: string }) => void): () => void;
  /** A tab closed. */
  onRemoved(listener: (tabId: number) => void): () => void;
  /** Sets one tab's toolbar badge text; empty clears it. */
  badge(tabId: number, text: string): Promise<void>;
}

/** A ref's frame and what it needs before acting. */
export interface RefInfo {
  frameId: number;
  frameOrigin: string;
  redacted: boolean;
  /** The element's ARIA role and accessible name, as the snapshot shows them. */
  role: string;
  name: string;
  /** The field's `maxlength`, when the browser enforces one. */
  max_length?: number;
}

/** The focused element, in the innermost frame that has focus. */
export interface Focused {
  frameId: number;
  frameOrigin: string;
  /** An enabled text input, a textarea or contenteditable: something `insertText` types into. */
  editable: boolean;
  role: string;
  name: string;
}

/** A checkbox, radio or switch's state. */
export interface CheckState {
  role: string;
  checked: boolean;
  disabled: boolean;
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

/** One tool a page offers through WebMCP; every field is the page's own text. */
export interface PageTool {
  name: string;
  title?: string;
  description: string;
  input_schema?: unknown;
  annotations?: Record<string, boolean>;
  /** The origin of the document that registered it. */
  origin: string;
  truncated?: boolean;
}

/** What a WebMCP call returned: the tool's text, or the message it failed with. */
export interface PageToolResult {
  result?: string;
  truncated?: boolean;
  error?: string;
}

export interface WebmcpCall {
  token: string;
  name: string;
  origin: string;
  input: Record<string, unknown>;
  fromOrigins: string[];
}

export interface Snapshot {
  title: string;
  text: string;
  redacted: number;
  truncated: boolean;
}

/** A file to hand a page: its name, MIME type and base64 bytes. */
export interface FileData {
  name: string;
  mimeType: string;
  data: string;
}

/** The page's main text as markdown, cut at `max_chars`. */
export interface PageText {
  title: string;
  text: string;
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
  /** The top frame's main text, or the text of `ref` in its own frame. */
  text(tabId: number, input: { ref?: string; max_chars: number }): Promise<PageText>;
  inspect(tabId: number, ref: string): Promise<RefInfo>;
  scrollTo(tabId: number, ref: string): Promise<Target>;
  /** With `end`, a field that didn't have focus gets its caret after its text, as `type` needs. */
  focus(tabId: number, ref: string, end?: boolean): Promise<void>;
  selectContents(tabId: number, ref: string): Promise<void>;
  /** What has focus, following focused frames inward. */
  focused(tabId: number): Promise<Focused>;
  /** `invalid_target` for anything but a checkbox, radio, switch or checkable menu item. */
  checkState(tabId: number, ref: string): Promise<CheckState>;
  selectOptions(tabId: number, ref: string, values: string[]): Promise<string[]>;
  /** Sets base64 files on an `<input type=file>` and fires `input` and `change`; gives how many it holds. */
  setFiles(tabId: number, ref: string, files: FileData[]): Promise<number>;
  scrollStart(
    tabId: number,
    input: { ref?: string; direction: Direction; amount?: number },
  ): Promise<ScrollStart | null>;
  scrollEnd(tabId: number, token: string): Promise<ScrollEnd>;
  scrollFallback(tabId: number, token: string): Promise<ScrollEnd>;
  domQuiet(tabId: number, input: { quiet: number; cap: number }): Promise<boolean>;
  viewport(tabId: number): Promise<Size>;
  iframes(tabId: number): Promise<{ frameId: number; sources: string[] }[]>;
  /** The main frame's URL, title, text and which of `selectors` it has, for wall detection. */
  probe(tabId: number, selectors: string[]): Promise<Probe>;
  strip(
    tabId: number,
    frameId: number,
    input: { reported: string[]; surplus: number },
  ): Promise<string[]>;
  /** `hidden` keeps a shown indicator out of the next captures without restarting its fade-in. */
  indicator(
    tabId: number,
    state: { visible?: boolean; cursor?: Point; hidden?: boolean },
  ): Promise<void>;
  /** Whether a top-level viewport point is on Sidekick's Stop button. */
  stopAt(tabId: number, point: Point): Promise<boolean>;
  /** Whether any frame's rendered text contains `text`, whitespace collapsed. */
  hasText(tabId: number, text: string): Promise<boolean>;
  /** Whether a ref's element has a box and isn't hidden; `stale_ref` once it is gone. */
  isVisible(tabId: number, ref: string): Promise<boolean>;
  /** Puts `EVAL_TAG` with `token` on a ref's element, or removes it when `token` is null. */
  tag(tabId: number, ref: string, token: string | null): Promise<void>;
  /** Turns the person's-steps recorder on or off in every frame of the tab. */
  record(tabId: number, on: boolean): Promise<void>;
  /** The WebMCP tools the top frame sees, cross-origin ones from `fromOrigins` included. */
  webmcpList(
    tabId: number,
    input: { fromOrigins: string[] },
  ): Promise<{ tools: PageTool[]; more: number }>;
  webmcpCall(tabId: number, input: WebmcpCall): Promise<PageToolResult>;
  webmcpCancel(tabId: number, token: string): Promise<void>;
  /** Shows the handoff card in the top frame, or removes it with `null`. */
  handoff(tabId: number, card: HandoffCard | null): Promise<void>;
}

/** What the page's handoff card shows: the agent's message, and the id Continue answers. */
export interface HandoffCard {
  id: string;
  message: string;
  /** Set while `demonstrate` records the person's steps, so the card says so (sidekick-21 req. 7). */
  recording?: boolean;
}
