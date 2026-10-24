import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { race } from '../abort';
import {
  type Act,
  aim,
  type BrowserEnv,
  enter,
  finish,
  fromScreenshot,
  inspectTarget,
  recheck,
  report,
  scrollIntoView,
  untrusted,
} from '../env';
import { click, drag, fill, hover, press } from '../input';
import type { Point } from '../types';
import { action, byTab, coordinate, modifiers, pointer, ref, tabId } from './schema';

const end = z.union([ref, z.object({ x: coordinate, y: coordinate })]);

async function settleAfter(act: Act, input: () => Promise<unknown>) {
  const settled = await act.env.settler.settle(act.tabId, act.signal, input);

  return untrusted(await finish(act, settled));
}

async function focusTarget(act: Act, element: string | undefined) {
  const info = element === undefined ? undefined : await inspectTarget(act, element);

  await recheck(act);
  await act.env.sessions.ensure(act.tabId, act.signal);

  if (element !== undefined) await scrollIntoView(act, element);

  return info;
}

function endpoint(act: Act, target: z.infer<typeof end>): () => Promise<Point> {
  if (typeof target !== 'string') {
    const point = fromScreenshot(act.env, act.tabId, target);

    return () => Promise.resolve(point);
  }

  return async () => {
    await inspectTarget(act, target, 'to');

    return (await race(act.env.page.scrollTo(act.tabId, target), act.signal)).point;
  };
}

export function inputTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'click',
      description: 'Click an element by ref, or a point in the last screenshot.',
      input: z.object({
        ...pointer,
        button: z.enum(['left', 'right', 'middle']).optional(),
        count: z.number().int().min(1).max(3).optional().describe('2 for a double click.'),
        modifiers,
      }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async (input, ctx) => {
        const act = await enter(env, ctx, input.tab_id, 'input');
        const point = await aim(act, input);

        return settleAfter(act, () => click(act, point, input));
      },
    }),
    defineTool({
      id: 'hover',
      description: 'Move the pointer over an element by ref, or a point in the last screenshot.',
      input: z.object(pointer),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async (input, ctx) => {
        const act = await enter(env, ctx, input.tab_id, 'input');
        const point = await aim(act, input);

        return settleAfter(act, () => hover(act, point));
      },
    }),
    defineTool({
      id: 'fill',
      description:
        'Replace a field’s text, by ref. Without a ref, types at the focused element (for canvas apps).',
      input: z.object({ tab_id: tabId, ref: ref.optional(), text: z.string() }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, ref: element, text }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input');
        const info = await focusTarget(act, element);

        if (info?.redacted) await report(act, { redacted: 'true' });

        return settleAfter(act, () => fill(act, element, text, info));
      },
    }),
    defineTool({
      id: 'select',
      description: 'Choose options in a <select>, by value or label.',
      input: z.object({ tab_id: tabId, ref, values: z.array(z.string()).min(1) }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, ref: element, values }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input');

        await inspectTarget(act, element);
        await recheck(act);

        return settleAfter(act, async () => {
          const chosen = await race(env.page.selectOptions(tab_id, element, values), act.signal);

          if (chosen.length < values.length) {
            throw new ToolError(
              'input_mismatch',
              `Only ${chosen.length} of ${values.length} options exist in ${element}.`,
              {
                selected: chosen,
              },
            );
          }
        });
      },
    }),
    defineTool({
      id: 'press',
      description:
        'Press a key or shortcut, like Enter, Escape, ArrowDown or Meta+A, on an element by ref or at the focused element.',
      input: z.object({ tab_id: tabId, key: z.string().min(1), ref: ref.optional() }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, key, ref: element }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input');

        await focusTarget(act, element);

        if (element !== undefined) await race(env.page.focus(tab_id, element), act.signal);

        return settleAfter(act, () => press(act, key));
      },
    }),
    defineTool({
      id: 'drag',
      description: 'Drag from one element or screenshot point to another.',
      input: z.object({ tab_id: tabId, from: end, to: end }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, from, to }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input');
        const start = await aim(act, typeof from === 'string' ? { ref: from } : from);
        const target = endpoint(act, to);

        return settleAfter(act, () => drag(act, start, target));
      },
    }),
  ];
}
