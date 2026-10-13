import { frameProtocol } from '../../protocol';
import type { Input, Output } from '../../rpc/define';
import { callFrame } from '../../rpc/frames';
import { RpcError } from '../../rpc/wire';
import { ToolError, type ToolErrorCode, type ToolErrorDetail } from '../../tool/tool';
import { removed } from '../content/refs';
import { type FrameOutline, stitch } from './stitch';
import type { Page, Point, ScrollStart, Tabs } from './types';

type Methods = (typeof frameProtocol)['methods'];

type PageMethod = Exclude<keyof Methods & string, 'frame.ping'>;

type Ok<K extends PageMethod> = Extract<Output<Methods, K>, { ok: unknown }>['ok'];

interface Outcome {
  ok?: unknown;
  error?: { code: ToolErrorCode; message: string; detail?: ToolErrorDetail };
}

const CALL_TIMEOUT_MS = 15_000;

const SNAPSHOT_TIMEOUT_MS = 10_000;

const MAX_FRAMES = 64;

const MAX_DEPTH = 8;

const REF = /^f(\d+)e\d+$/;

/** The frame a ref names: `f3e12` is in frame 3. */
export function frameOfRef(ref: string) {
  const match = REF.exec(ref);

  if (!match) throw removed(ref);

  return Number(match[1]);
}

function unsupported() {
  return new ToolError(
    'unsupported_page',
    'Sidekick can’t read this page: it is a browser page, the Web Store, or blocks extensions. Navigate to a website first.',
  );
}

function pageError(error: unknown, ref: string | undefined): never {
  if (error instanceof RpcError && error.code === 'disconnected') {
    throw ref ? removed(ref) : unsupported();
  }

  if (error instanceof RpcError && error.code === 'timeout') {
    throw new ToolError(
      'timeout',
      'The page didn’t answer in time. Wait a moment, then try again.',
    );
  }

  throw error;
}

interface CallOptions {
  ref?: string;
  timeout?: number;
  inject?: boolean;
}

export interface ChromePageOptions {
  tabs: Tabs;
  /** Injects the content script into a frame that has none, such as a tab open before install. */
  inject?: (tabId: number, frameId: number) => Promise<void>;
}

/** `Page` over `chrome.tabs.sendMessage`: one content script per frame, refs routed by their frame. */
export function chromePage({ tabs, inject }: ChromePageOptions): Page {
  const docs = new Map<number, Map<number, string>>();
  const learned = new Map<number, Map<number, number>>();
  const key = crypto.randomUUID();

  const call = async <K extends PageMethod>(
    tabId: number,
    frameId: number,
    method: K,
    input: Input<Methods, K>,
    { ref, timeout = CALL_TIMEOUT_MS, inject: retry = true }: CallOptions = {},
  ): Promise<Ok<K>> => {
    const attempt = async (): Promise<Outcome> =>
      callFrame(frameProtocol, { tabId, frameId }, method, input, { timeout });

    let output: Outcome;

    try {
      try {
        output = await attempt();
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== 'disconnected' || !inject || !retry) {
          throw error;
        }

        await inject(tabId, frameId).catch(() => undefined);
        output = await attempt();
      }
    } catch (error) {
      return pageError(error, ref);
    }

    if (output.error) {
      throw new ToolError(output.error.code, output.error.message, output.error.detail);
    }

    return output.ok as Ok<K>;
  };

  const docOf = (tabId: number, frameId: number) => docs.get(tabId)?.get(frameId);

  const remember = (tabId: number, frameId: number, doc: string) => {
    if (frameId === 0 && docOf(tabId, 0) !== doc) {
      docs.set(tabId, new Map());
      learned.set(tabId, new Map());
    }

    const frames = docs.get(tabId) ?? new Map<number, string>();

    frames.set(frameId, doc);
    docs.set(tabId, frames);
  };

  const byRef = (tabId: number, ref: string) => {
    const frameId = frameOfRef(ref);

    return { frameId, input: { ref, doc: docOf(tabId, frameId) } };
  };

  const ancestry = async (tabId: number, frameId: number, ref?: string) => {
    if (frameId === 0) return [0];

    const parents = new Map([
      ...(learned.get(tabId) ?? []),
      ...(await tabs.frames(tabId)).map(
        (frame) => [frame.frameId, frame.parentFrameId] as [number, number],
      ),
    ]);

    const chain = [frameId];

    for (let id = frameId; id !== 0;) {
      const parent = parents.get(id);

      if (parent === undefined || parent < 0 || chain.length > MAX_DEPTH) {
        throw ref ? removed(ref) : unsupported();
      }

      chain.push(parent);
      id = parent;
    }

    return chain;
  };

  const childFrames = async (tabId: number) => {
    const frames = await tabs.frames(tabId).catch(() => []);

    return (parent: number) =>
      frames.flatMap(({ frameId, parentFrameId, url }) =>
        parentFrameId === parent ? [{ frameId, url }] : [],
      );
  };

  const lift = async (tabId: number, chain: number[], point: Point) => {
    const offset = { x: 0, y: 0 };
    const childrenOf = await childFrames(tabId);
    let obscured: string | undefined;

    for (let index = 0; index + 1 < chain.length; index++) {
      const box = await call(tabId, chain[index + 1] ?? 0, 'page.frameBox', {
        frameId: chain[index] ?? 0,
        reveal: false,
        point: { x: point.x + offset.x, y: point.y + offset.y },
        children: childrenOf(chain[index + 1] ?? 0),
        key,
      });

      offset.x += box.origin.x;
      offset.y += box.origin.y;
      obscured ??= box.obscured_by;
    }

    return { offset, obscured };
  };

  const placeStart = async (
    tabId: number,
    chain: number[],
    start: { token: string; container: string; point: Point; delta: Point },
  ): Promise<ScrollStart> => {
    const { offset } =
      chain.length > 1 ? await lift(tabId, chain, start.point) : { offset: { x: 0, y: 0 } };

    return {
      token: `${chain[0] ?? 0}:${start.token}`,
      container: start.container,
      point: { x: start.point.x + offset.x, y: start.point.y + offset.y },
      delta: start.delta,
    };
  };

  const splitToken = (token: string) => {
    const [frame = '0', id = ''] = token.split(':');

    return { frameId: Number(frame), token: id };
  };

  return {
    key,
    snapshot: async (tabId, { scope, ref, max_chars }) => {
      const start = ref === undefined ? 0 : frameOfRef(ref);
      const outlines = new Map<number, FrameOutline | undefined>();
      const childrenOf = await childFrames(tabId);

      const read = async (frameId: number, subtree?: string) => {
        const result = await call(
          tabId,
          frameId,
          'page.snapshot',
          {
            frameId,
            scope,
            ref: subtree,
            doc: subtree === undefined ? undefined : docOf(tabId, frameId),
            max_chars,
            children: childrenOf(frameId),
            key,
          },
          { ref: subtree, timeout: SNAPSHOT_TIMEOUT_MS },
        );

        remember(tabId, frameId, result.doc);
        outlines.set(frameId, result);

        return result;
      };

      const children = (frameId: number, outline: FrameOutline) =>
        outline.lines.flatMap((line) => {
          if (line.frame === undefined) return [];

          const parents = learned.get(tabId) ?? new Map<number, number>();

          parents.set(line.frame, frameId);
          learned.set(tabId, parents);

          return [line.frame];
        });

      const first = await read(start, ref);
      let wave = children(start, first);

      while (wave.length > 0 && outlines.size < MAX_FRAMES) {
        const next = [...new Set(wave)]
          .filter((frameId) => !outlines.has(frameId))
          .slice(0, MAX_FRAMES - outlines.size);

        for (const frameId of next) outlines.set(frameId, undefined);

        const results = await Promise.all(
          next.map(async (frameId) => {
            const outline = await read(frameId).catch(() => undefined);

            return outline ? children(frameId, outline) : [];
          }),
        );

        wave = results.flat();
      }

      return { title: first.title, ...stitch(outlines, start, max_chars) };
    },
    inspect: async (tabId, ref) => {
      const { frameId, input } = byRef(tabId, ref);
      const info = await call(tabId, frameId, 'page.inspect', input, { ref });

      return { frameId, ...info };
    },
    scrollTo: async (tabId, ref) => {
      const { frameId, input } = byRef(tabId, ref);
      const chain = await ancestry(tabId, frameId, ref);
      const childrenOf = chain.length > 1 ? await childFrames(tabId) : () => [];

      for (let index = chain.length - 2; index >= 0; index--) {
        await call(tabId, chain[index + 1] ?? 0, 'page.frameBox', {
          frameId: chain[index] ?? 0,
          reveal: true,
          children: childrenOf(chain[index + 1] ?? 0),
          key,
        });
      }

      const target = await call(tabId, frameId, 'page.scrollTo', input, { ref });

      if (chain.length === 1) return target;

      const { offset, obscured } = await lift(tabId, chain, target.point);

      return {
        point: { x: target.point.x + offset.x, y: target.point.y + offset.y },
        rect: { ...target.rect, x: target.rect.x + offset.x, y: target.rect.y + offset.y },
        in_view: target.in_view && obscured === undefined,
        obscured_by: target.obscured_by ?? obscured,
      };
    },
    focus: async (tabId, ref) => {
      const { frameId, input } = byRef(tabId, ref);

      await call(tabId, frameId, 'page.focus', input, { ref });
    },
    selectContents: async (tabId, ref) => {
      const { frameId, input } = byRef(tabId, ref);

      await call(tabId, frameId, 'page.selectContents', input, { ref });
    },
    readValue: async (tabId, ref) => {
      const { frameId, input } = byRef(tabId, ref);

      return call(tabId, frameId, 'page.readValue', input, { ref });
    },
    selectOptions: async (tabId, ref, values) => {
      const { frameId, input } = byRef(tabId, ref);

      return call(tabId, frameId, 'page.selectOptions', { ...input, values }, { ref });
    },
    scrollStart: async (tabId, { ref, direction, amount }) => {
      if (ref !== undefined) {
        const { frameId, input } = byRef(tabId, ref);
        const chain = await ancestry(tabId, frameId, ref);

        const { start } = await call(
          tabId,
          frameId,
          'page.scrollStart',
          { ...input, direction, amount },
          { ref },
        );

        return start && placeStart(tabId, chain, start);
      }

      const childrenOf = await childFrames(tabId);

      const begin = async (chain: number[], point?: Point): Promise<ScrollStart | null> => {
        const { start, descend } = await call(tabId, chain[0] ?? 0, 'page.scrollStart', {
          point,
          direction,
          amount,
          children: childrenOf(chain[0] ?? 0),
          key,
        });

        if (descend && chain.length < MAX_DEPTH) {
          const inner = await begin([descend.frameId, ...chain], descend.point).catch(() => null);

          if (inner) return inner;
        }

        return start && placeStart(tabId, chain, start);
      };

      return begin([0]);
    },
    scrollEnd: (tabId, token) => {
      const target = splitToken(token);

      return call(tabId, target.frameId, 'page.scrollEnd', { token: target.token });
    },
    scrollFallback: (tabId, token) => {
      const target = splitToken(token);

      return call(tabId, target.frameId, 'page.scrollFallback', { token: target.token });
    },
    domQuiet: (tabId, { quiet, cap }) =>
      call(tabId, 0, 'page.domQuiet', { quiet, cap }, { timeout: cap + CALL_TIMEOUT_MS }),
    viewport: (tabId) => call(tabId, 0, 'page.viewport', {}),
    iframes: async (tabId) => {
      const frames = await tabs.frames(tabId);

      const found = await Promise.all(
        frames.map(async ({ frameId }) => ({
          frameId,
          sources: await call(tabId, frameId, 'page.iframes', {}, { inject: false }).catch(
            () => undefined,
          ),
        })),
      );

      return found.flatMap(({ frameId, sources }) => (sources ? [{ frameId, sources }] : []));
    },
    strip: (tabId, frameId, input) => call(tabId, frameId, 'page.strip', input, { inject: false }),
    indicator: async (tabId, state) => {
      await call(tabId, 0, 'page.indicator', state);
    },
  };
}
