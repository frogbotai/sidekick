import { z } from 'zod';

import { defineTool } from '../../../tool/tool';
import { type BrowserEnv, getTab, notInGroup, runOf } from '../env';
import { HANDOFF_TIMEOUT } from '../handoff';
import { type DemonstrationStep, summarize } from '../recordings';
import { HANDOFF_MESSAGE_LIMIT } from './handoff';
import { tabId } from './schema';

const step = z.object({
  kind: z.enum(['click', 'fill', 'check', 'select', 'file', 'navigation']),
  url: z.string().optional().describe('navigation only: the new document.'),
  frameUrl: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  nearby: z.string().optional().describe('The nearest labelled container or heading.'),
  selector: z.string().optional().describe('A CSS path, only to break a tie between matches.'),
  value: z.string().optional(),
  masked: z
    .string()
    .optional()
    .describe('The kind of personal value typed, like "street-address"; ask the user for it.'),
  redacted: z.boolean().optional().describe('A secret was typed; the user must enter it.'),
  checked: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

const DIALOG_NOTE =
  'A browser dialog opened during the demonstration; the user answered it, and that part wasn’t recorded.';

function lastUrl(steps: DemonstrationStep[], fallback: string) {
  return steps.findLast((entry) => entry.kind === 'navigation')?.url ?? fallback;
}

export function demonstrateTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'demonstrate',
      description: [
        'Ask the user to show you how to do something in the tab, when it is quicker for them to do it once than to describe it. The tab comes to the front with a card showing your message, a line saying their clicks and typing are recorded, and a Continue button, and this call waits until they click Continue.',
        'It returns the steps they took (clicks, typing, checks, selects, chosen files and new pages) and a numbered summary. Passwords and codes come back as redacted and personal details (name, address, email, phone) as masked, so ask the user for those values when you repeat the flow. A browser dialog the user answers is not a step; the summary notes one when Sidekick saw it.',
        'To repeat it, take a new snapshot and match each step by role and name, using nearby text and then the selector only to break ties. timeout: ask in chat before asking again. cancelled: the run was stopped or the tab closed.',
      ].join(' '),
      input: z.object({
        tab_id: tabId,
        message: z
          .string()
          .trim()
          .min(1)
          .max(HANDOFF_MESSAGE_LIMIT)
          .describe(
            'What to show you, then click Continue, like "Show me how you file an expense report".',
          ),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(HANDOFF_TIMEOUT)
          .optional()
          .describe('How long to wait, at most 600,000 (10 minutes), the default.'),
      }),
      output: z.object({
        status: z.enum(['resolved', 'timeout', 'cancelled']),
        reason: z
          .enum(['stopped', 'tab_closed'])
          .optional()
          .describe('cancelled only: the run was stopped or the tab closed.'),
        started_url: z.string(),
        ended_url: z.string(),
        steps: z.array(step),
        summary: z.string().describe('One numbered line per step.'),
      }),
      permission: 'handoff',
      execute: async ({ tab_id, message, timeout_ms }, ctx) => {
        const { run, signal } = runOf(env, ctx);
        const tab = await getTab(env, tab_id, signal);

        if (!env.runs.owns(run, tab)) throw notInGroup(tab_id);

        const recording = await env.recordings.start(tab_id);
        const dialog = env.dialogs.opened(tab_id);
        let dialogs = false;

        void dialog.promise.then(() => (dialogs = true));

        const ended = env.handoffs.wait({
          tabId: tab_id,
          message,
          timeout: timeout_ms ?? HANDOFF_TIMEOUT,
          signal,
          recording: true,
          ...(run.sessionID ? { sessionID: run.sessionID } : {}),
        });

        await env.tabs.activate(tab_id).catch(() => undefined);

        const end = await ended;
        const steps = await env.recordings.stop(tab_id, recording);

        dialog.stop();

        const summary = summarize(steps) || 'The user did nothing that was recorded.';

        const now = await env.tabs.get(tab_id).catch(() => undefined);

        return {
          output: {
            ...end,
            started_url: tab.url,
            ended_url: now?.url ?? lastUrl(steps, tab.url),
            steps,
            summary: dialogs ? `${summary}\n${DIALOG_NOTE}` : summary,
          },
        };
      },
    }),
  ];
}
