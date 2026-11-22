import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { delay, race } from '../abort';
import { type Act, type BrowserEnv, enter, getTab, inspectTarget, untrusted } from '../env';
import { runScript } from '../script';
import { byTab, ref, tabId } from './schema';

export const WAIT_TIMEOUT_MS = 10_000;

export const MAX_WAIT_MS = 30_000;

export const POLL_MS = 250;

const CONDITIONS = ['text', 'text_gone', 'url', 'ref', 'load'] as const;

const waitInput = z.object({
  tab_id: tabId,
  text: z.string().trim().min(1).optional().describe('Wait until this text shows on the page.'),
  text_gone: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Wait until this text is gone from the page.'),
  url: z.string().min(1).optional().describe('Wait until the tab’s URL contains this.'),
  ref: ref.optional().describe('Wait until this element is visible, or hidden with state.'),
  state: z.enum(['visible', 'hidden']).optional().describe('For ref; visible when left out.'),
  load: z.literal(true).optional().describe('Wait until the page finishes loading.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_MS)
    .optional()
    .describe('Give up after this long; 10,000 when left out.'),
});

type WaitInput = z.infer<typeof waitInput>;

interface Condition {
  what: string;
  holds: (left: number) => Promise<boolean>;
}

function quoted(text: string) {
  return `“${text.length > 80 ? `${text.slice(0, 80)}…` : text}”`;
}

async function softly(act: Act, probe: Promise<boolean>) {
  try {
    return await race(probe, act.signal);
  } catch (error) {
    if (act.signal.aborted || !(error instanceof ToolError)) throw error;

    return undefined;
  }
}

function isRemoved(error: unknown) {
  return (
    error instanceof ToolError && error.code === 'stale_ref' && error.detail?.reason === 'removed'
  );
}

async function refShown(act: Act, element: string, hidden: boolean) {
  try {
    return await race(act.env.page.isVisible(act.tabId, element), act.signal);
  } catch (error) {
    if (hidden && isRemoved(error)) return false;

    throw error;
  }
}

async function conditionOf(act: Act, input: WaitInput): Promise<Condition> {
  const set = CONDITIONS.filter((key) => input[key] !== undefined);

  if (set.length !== 1) {
    throw new ToolError(
      'invalid_target',
      `Give exactly one of ${CONDITIONS.join(', ')}; this call gave ${set.length === 0 ? 'none' : set.join(' and ')}.`,
    );
  }

  if (input.state !== undefined && input.ref === undefined) {
    throw new ToolError('invalid_target', 'state goes with ref. Give the element’s ref too.');
  }

  const { page, tabs } = act.env;
  const { text, text_gone: gone, url, ref: element, state = 'visible' } = input;

  if (text !== undefined) {
    return {
      what: `text ${quoted(text)} to appear`,
      holds: async () => (await softly(act, page.hasText(act.tabId, text))) === true,
    };
  }

  if (gone !== undefined) {
    return {
      what: `text ${quoted(gone)} to go away`,
      holds: async () => (await softly(act, page.hasText(act.tabId, gone))) === false,
    };
  }

  if (url !== undefined) {
    return {
      what: `the URL to contain ${quoted(url)}`,
      holds: async () => (await getTab(act.env, act.tabId, act.signal)).url.includes(url),
    };
  }

  if (element !== undefined) {
    const hidden = state === 'hidden';

    await inspectTarget(act, element).catch((error: unknown) => {
      if (!(hidden && isRemoved(error))) throw error;
    });

    return {
      what: `${element} to become ${state}`,
      holds: async () => (await refShown(act, element, hidden)) !== hidden,
    };
  }

  return {
    what: 'the page to finish loading',
    holds: (left) => race(tabs.waitForLoad(act.tabId, left), act.signal),
  };
}

async function within(holds: Condition['holds'], left: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = holds(Math.max(left, 0));
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(left, 0));
  });

  probe.catch(() => undefined);

  try {
    return await Promise.race([probe, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(act: Act, input: WaitInput) {
  const timeout = input.timeout_ms ?? WAIT_TIMEOUT_MS;
  const condition = await conditionOf(act, input);
  const started = Date.now();
  const deadline = started + timeout;

  for (;;) {
    if (await within(condition.holds, deadline - Date.now())) return Date.now() - started;

    const left = deadline - Date.now();

    if (left <= 0) break;

    await delay(Math.min(POLL_MS, left), act.signal);
  }

  const tab = await getTab(act.env, act.tabId, act.signal);
  const now = input.url === undefined ? '' : ` The URL is ${tab.url}.`;

  throw new ToolError(
    'timeout',
    `Waited ${timeout / 1000} s for ${condition.what}; it didn’t happen.${now} Take a snapshot to see the page.`,
  );
}

export function pageTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'wait_for',
      description:
        'Wait until text appears or goes away, the URL contains something, an element shows or hides, or the page loads. Give exactly one condition. Use it instead of guessing how long something takes.',
      input: waitInput,
      output: z.object({
        url: z.string(),
        waited_ms: z.number().describe('How long the condition took to hold.'),
      }),
      permission: 'read',
      lock: byTab,
      execute: async (input, ctx) => {
        const act = await enter(env, ctx, input.tab_id, 'read');
        const waited = await waitFor(act, input);
        const tab = await getTab(env, input.tab_id, act.signal);

        return untrusted({ url: tab.url, waited_ms: waited });
      },
    }),
    defineTool({
      id: 'eval',
      description:
        'Run JavaScript in the page and get its result as JSON. Promises are awaited, and it stops after 30 s. With a ref, script must be a function that receives the element, like (el) => el.value. Use it to read what the snapshot leaves out; act on the page with the other tools.',
      input: z.object({
        tab_id: tabId,
        script: z.string().min(1),
        ref: ref.optional(),
      }),
      output: z.object({
        value: z.string().describe('The result as JSON text.'),
        truncated: z.boolean().describe('The result was cut at 20,000 characters.'),
      }),
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, script, ref: element }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input');

        if (element !== undefined) await inspectTarget(act, element);

        return untrusted(await runScript(act, script, element));
      },
    }),
  ];
}
