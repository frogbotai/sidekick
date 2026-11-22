import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { race } from '../abort';
import { baselineOf, keepBaseline } from '../baselines';
import {
  type Act,
  type BrowserEnv,
  enter,
  fromScreenshotRect,
  getTab,
  inspect,
  inspectTarget,
  onPage,
  send,
  untrusted,
} from '../env';
import { DIFF_THRESHOLD, pixelDiff } from '../pixeldiff';
import { screenshot } from '../screenshot';
import type { ScrollEnd, ScrollStart } from '../types';
import { byTab, ref, tabId } from './schema';

export const MAX_CHARS = 30_000;

export const MAX_CHARS_CAP = 100_000;

export const MIN_CHARS = 1_000;

const baselineName = z.string().trim().min(1).max(64);

const maxChars = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('At most this many characters, from 1,000 to 100,000; 30,000 when left out.');

function clampChars(max: number | undefined) {
  return Math.min(Math.max(max ?? MAX_CHARS, MIN_CHARS), MAX_CHARS_CAP);
}

async function attachForScroll(act: Act) {
  try {
    await act.env.sessions.ensure(act.tabId, act.signal);

    return true;
  } catch (error) {
    if (error instanceof ToolError && error.code === 'attach_blocked') return false;

    throw error;
  }
}

async function wheel(act: Act, start: ScrollStart, attached: boolean): Promise<ScrollEnd> {
  const { page } = act.env;

  if (!attached) return onPage(act, () => page.scrollFallback(act.tabId, start.token));

  await page.indicator(act.tabId, { cursor: start.point }).catch(() => undefined);

  await send(act, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...start.point,
    button: 'none',
  });

  await send(act, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...start.point,
    deltaX: start.delta.x,
    deltaY: start.delta.y,
  });

  const end = await onPage(act, () => page.scrollEnd(act.tabId, start.token));

  if (end.moved > 0) return end;

  return onPage(act, () => page.scrollFallback(act.tabId, start.token));
}

async function clean<T>(act: Act, capture: () => Promise<T>) {
  const hide = (hidden: boolean) =>
    act.env.page.indicator(act.tabId, { hidden }).catch(() => undefined);

  await hide(true);

  try {
    return await capture();
  } finally {
    await hide(false);
  }
}

export function readTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'snapshot',
      description:
        'Read the page as an accessibility outline with element refs (f0e12) for the other tools. Covers the viewport and one screen around it unless scope is page.',
      input: z.object({
        tab_id: tabId,
        scope: z.enum(['viewport', 'page']).optional(),
        ref: ref.optional().describe('Read only this element’s subtree, not the page.'),
        max_chars: maxChars,
      }),
      output: z.object({
        url: z.string(),
        title: z.string(),
        snapshot: z.string(),
        redacted: z.number(),
        truncated: z.boolean(),
      }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, scope, ref: subtree, max_chars }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');

        if (subtree !== undefined) await inspect(act, subtree);

        const snapshot = await onPage(act, () =>
          env.page.snapshot(tab_id, {
            scope: scope ?? 'viewport',
            ref: subtree,
            max_chars: clampChars(max_chars),
          }),
        );

        const read = await getTab(env, tab_id, act.signal);

        return untrusted({
          url: read.url,
          title: snapshot.title,
          snapshot: snapshot.text,
          redacted: snapshot.redacted,
          truncated: snapshot.truncated,
        });
      },
    }),
    defineTool({
      id: 'page_text',
      description:
        'Read the page’s main text as markdown, to read or summarise it; use snapshot to act. Top frame only, unless ref points inside a frame.',
      input: z.object({
        tab_id: tabId,
        ref: ref.optional().describe('Read this element’s text instead of the main content.'),
        max_chars: maxChars,
      }),
      output: z.object({
        url: z.string(),
        title: z.string(),
        text: z.string(),
        truncated: z.boolean(),
      }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, ref: element, max_chars }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');

        if (element !== undefined) await inspect(act, element);

        const page = await onPage(act, () =>
          env.page.text(tab_id, { ref: element, max_chars: clampChars(max_chars) }),
        );

        const read = await getTab(env, tab_id, act.signal);

        return untrusted({
          url: read.url,
          title: page.title,
          text: page.text,
          truncated: page.truncated,
        });
      },
    }),
    defineTool({
      id: 'screenshot',
      description:
        'Capture the visible part of a tab, or one element. Pass region (pixels of your last screenshot) and a scale up to 4 to look closely at small text; without a debugger attached, a region is only cropped, not sharpened. click, hover and drag accept x and y in this image’s pixels. Give a name to keep it as a baseline for screenshot_diff; a named capture leaves out Sidekick’s indicator. Otherwise, while Sidekick runs, the image also shows Sidekick’s own indicator, which isn’t part of the page: a dim tint with a coloured glow at the edges, a green arrow where the pointer last was, and a red “Stop Sidekick” button at the bottom centre; never click that button.',
      input: z.object({
        tab_id: tabId,
        scale: z
          .number()
          .min(0.1)
          .max(4)
          .optional()
          .describe(
            'Image pixels per CSS pixel; 1 when left out. Images stay within 2,000 pixels.',
          ),
        ref: ref.optional(),
        region: z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .optional()
          .describe('An area of your last screenshot of this tab, in its pixels.'),
        name: baselineName
          .optional()
          .describe('Keep this capture as a baseline under this name, for screenshot_diff.'),
      }),
      output: z.object({ url: z.string(), width: z.number(), height: z.number() }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, scale = 1, ref: element, region, name }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');
        const clip =
          name !== undefined && region && element === undefined
            ? fromScreenshotRect(env, tab_id, region)
            : undefined;

        const take = () =>
          screenshot(act, { scale, ref: element, region: clip ? undefined : region, clip });

        const capture = name === undefined ? await take() : await clean(act, take);
        const read = await getTab(env, tab_id, act.signal);

        if (name !== undefined) {
          keepBaseline(act.run, name, { tabId: tab_id, scale, ref: element, clip, capture });
        }

        return untrusted({ url: read.url, width: capture.width, height: capture.height }, [
          {
            type: 'file',
            uri: `data:${capture.mime};base64,${capture.data}`,
            mime: capture.mime,
            name: 'screenshot',
          },
        ]);
      },
    }),
    defineTool({
      id: 'screenshot_diff',
      description:
        'Capture the tab again the way a named baseline screenshot was taken (same scale, element and region) and compare the two. Returns how many pixels changed and an image with unchanged pixels gray and changed ones red. The images must be the same size: keep the viewport and zoom unchanged between them. click, hover and drag x and y still refer to the last screenshot, not this image.',
      input: z.object({
        tab_id: tabId,
        baseline: baselineName.describe('The name given to screenshot.'),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `How far a pixel’s colour may move before it counts as changed, from 0 (any change) to 1; ${DIFF_THRESHOLD} when left out.`,
          ),
      }),
      output: z.object({
        url: z.string(),
        width: z.number(),
        height: z.number(),
        changed_pixels: z.number(),
        changed_share: z.number(),
      }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, baseline: name, threshold = DIFF_THRESHOLD }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');
        const baseline = baselineOf(act.run, name, tab_id);
        const capture = await clean(act, () =>
          screenshot(act, {
            scale: baseline.scale,
            ref: baseline.ref,
            clip: baseline.clip,
            keepMap: false,
          }),
        );

        const [before, after] = await race(
          Promise.all([env.images.decode(baseline.capture), env.images.decode(capture)]),
          act.signal,
        );

        const diff = pixelDiff(before, after, threshold);
        const png = await race(env.images.png(diff.image), act.signal);
        const read = await getTab(env, tab_id, act.signal);
        const total = diff.image.width * diff.image.height;

        return untrusted(
          {
            url: read.url,
            width: diff.image.width,
            height: diff.image.height,
            changed_pixels: diff.changed,
            changed_share: Number((diff.changed / total).toPrecision(3)),
          },
          [{ type: 'file', uri: `data:image/png;base64,${png}`, mime: 'image/png', name: 'diff' }],
        );
      },
    }),
    defineTool({
      id: 'scroll',
      description:
        'Scroll the container under an element (or the middle of the viewport). Reports how far it moved and whether it reached the end.',
      input: z.object({
        tab_id: tabId,
        ref: ref.optional(),
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CSS pixels; most of a screen when left out.'),
      }),
      output: z.object({ moved: z.number(), container: z.string(), at_end: z.boolean() }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, ref: element, direction, amount }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');

        if (element !== undefined) await inspect(act, element);

        const attached = await attachForScroll(act);

        const start = await onPage(act, () =>
          env.page.scrollStart(tab_id, { ref: element, direction, amount }),
        );

        if (!start) return untrusted({ moved: 0, container: 'none', at_end: true });

        const end = await wheel(act, start, attached);

        return untrusted({ moved: end.moved, container: start.container, at_end: end.at_end });
      },
    }),
    defineTool({
      id: 'scroll_to',
      description: 'Scroll an element into view and say whether anything covers it.',
      input: z.object({ tab_id: tabId, ref }),
      output: z.object({ in_view: z.boolean(), obscured_by: z.string().optional() }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, ref: element }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');

        await inspectTarget(act, element);

        const target = await onPage(act, () => env.page.scrollTo(tab_id, element));

        return untrusted({ in_view: target.in_view, obscured_by: target.obscured_by });
      },
    }),
  ];
}
