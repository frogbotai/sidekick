import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { race } from '../abort';
import {
  type Act,
  type BrowserEnv,
  enter,
  getTab,
  inspect,
  inspectTarget,
  send,
  untrusted,
} from '../env';
import { screenshot } from '../screenshot';
import type { ScrollEnd, ScrollStart } from '../types';
import { byTab, ref, tabId } from './schema';

export const MAX_CHARS = 30_000;

export const MAX_CHARS_CAP = 100_000;

export const MIN_CHARS = 1_000;

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

  if (!attached) return race(page.scrollFallback(act.tabId, start.token), act.signal);

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

  const end = await race(page.scrollEnd(act.tabId, start.token), act.signal);

  if (end.moved > 0) return end;

  return race(page.scrollFallback(act.tabId, start.token), act.signal);
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
        max_chars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('At most this many characters, from 1,000 to 100,000; 30,000 when left out.'),
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

        const snapshot = await race(
          env.page.snapshot(tab_id, {
            scope: scope ?? 'viewport',
            ref: subtree,
            max_chars: Math.min(Math.max(max_chars ?? MAX_CHARS, MIN_CHARS), MAX_CHARS_CAP),
          }),
          act.signal,
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
      id: 'screenshot',
      description:
        'Capture the visible part of a tab, or one element. click, hover and drag accept x and y in this image’s pixels.',
      input: z.object({
        tab_id: tabId,
        scale: z.number().min(0.1).max(1).optional(),
        ref: ref.optional(),
      }),
      output: z.object({ url: z.string(), width: z.number(), height: z.number() }),
      permission: 'read',
      lock: byTab,
      execute: async ({ tab_id, scale, ref: element }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'read');
        const capture = await screenshot(act, { scale: scale ?? 1, ref: element });
        const read = await getTab(env, tab_id, act.signal);

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

        const start = await race(
          env.page.scrollStart(tab_id, { ref: element, direction, amount }),
          act.signal,
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

        const target = await race(env.page.scrollTo(tab_id, element), act.signal);

        return untrusted({ in_view: target.in_view, obscured_by: target.obscured_by });
      },
    }),
  ];
}
