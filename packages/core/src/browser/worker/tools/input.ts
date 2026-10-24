import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { race } from '../abort';
import {
  type Act,
  aim,
  type BrowserEnv,
  enter,
  finish,
  focusedField,
  fromScreenshot,
  inspectTarget,
  offStop,
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

async function stateAfter(act: Act, element: string) {
  try {
    return await race(act.env.page.checkState(act.tabId, element), act.signal);
  } catch (error) {
    if (!(error instanceof ToolError && error.code === 'stale_ref')) throw error;

    if (error.detail?.reason === 'navigated') throw error;

    throw new ToolError(
      'stale_ref',
      `${element} was replaced after the click. Take a new snapshot; check is safe to repeat.`,
      error.detail,
    );
  }
}

async function check(act: Act, element: string, checked: boolean) {
  await inspectTarget(act, element);

  const before = await race(act.env.page.checkState(act.tabId, element), act.signal);

  if (before.checked === checked) {
    return untrusted({ ...(await finish(act, true)), checked, changed: false });
  }

  if (before.disabled) {
    throw new ToolError('invalid_target', `${element} is disabled. Look for what enables it.`);
  }

  if (!checked && /radio$/.test(before.role)) {
    throw new ToolError(
      'invalid_target',
      'A selected radio can’t be cleared by clicking it. Check another option in its group instead.',
    );
  }

  await recheck(act);
  await act.env.sessions.ensure(act.tabId, act.signal);

  const point = await scrollIntoView(act, element);
  const settled = await act.env.settler.settle(act.tabId, act.signal, () => click(act, point, {}));

  const after = await stateAfter(act, element);

  if (after.checked !== checked) {
    throw new ToolError(
      'input_mismatch',
      `The page didn’t keep ${element} ${checked ? 'checked' : 'unchecked'}. Take a snapshot and look for a message on the page; don’t toggle it again.`,
      { checked: after.checked },
    );
  }

  return untrusted({ ...(await finish(act, settled)), checked, changed: true });
}

async function endpoint(act: Act, target: z.infer<typeof end>): Promise<() => Promise<Point>> {
  if (typeof target !== 'string') {
    const point = await offStop(act, fromScreenshot(act.env, act.tabId, target));

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
      description:
        'Click an element by ref, or a point in the last screenshot. For checkboxes, radios and switches, use check.',
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
        'Replace a field’s text, by ref. Without a ref, types into the focused field (for canvas apps and spreadsheets), and fails when nothing editable has focus. For checkboxes, radios and switches, use check.',
      input: z.object({ tab_id: tabId, ref: ref.optional(), text: z.string() }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, ref: element, text }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input');

        if (element === undefined) await focusedField(act);

        const info = await focusTarget(act, element);

        if (info?.redacted) await report(act, { redacted: 'true' });

        return settleAfter(act, () => fill(act, element, text, info));
      },
    }),
    defineTool({
      id: 'check',
      description:
        'Check or uncheck a checkbox, radio or switch, by ref. Clicks only when its state differs, so it is safe to repeat.',
      input: z.object({
        tab_id: tabId,
        ref,
        checked: z.boolean().describe('true to check it, false to uncheck it.'),
      }),
      output: action.extend({
        checked: z.boolean().describe('The state the control is in now.'),
        changed: z
          .boolean()
          .describe('false when it was already in that state, so nothing was clicked.'),
      }),
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, ref: element, checked }, ctx) =>
        check(await enter(env, ctx, tab_id, 'input'), element, checked),
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
        const target = await endpoint(act, to);

        return settleAfter(act, () => drag(act, start, target));
      },
    }),
  ];
}
