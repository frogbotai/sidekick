import { z } from 'zod';

import { defineTool } from '../../../tool/tool';
import { type BrowserEnv, getTab, notInGroup, runOf } from '../env';
import { HANDOFF_TIMEOUT } from '../handoff';
import { byTab, tabId } from './schema';

export const HANDOFF_MESSAGE_LIMIT = 300;

export function handoffTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'handoff',
      description: [
        'Hand the tab to the user for something only they should do: sign in, a 2FA code, a passkey, a captcha, or confirming a payment. Never type passwords, codes or card numbers yourself.',
        'The tab comes to the front with a card showing your message and a Continue button, and this call waits until the user clicks Continue. While it waits, no other tool can use the tab.',
        'resolved: take a new snapshot before acting, since the page has likely changed. timeout: ask the user in chat before handing off again. cancelled: the run was stopped or the tab closed.',
      ].join(' '),
      input: z.object({
        tab_id: tabId,
        message: z
          .string()
          .trim()
          .min(1)
          .max(HANDOFF_MESSAGE_LIMIT)
          .describe('What the user should do, then click Continue, like "Sign in to your bank".'),
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
          .describe('cancelled only: the run was stopped, or the tab closed.'),
      }),
      permission: 'handoff',
      lock: byTab,
      execute: async ({ tab_id, message, timeout_ms }, ctx) => {
        const { run, signal } = runOf(env, ctx);
        const tab = await getTab(env, tab_id, signal);

        if (!env.runs.owns(run, tab)) throw notInGroup(tab_id);

        await env.tabs.activate(tab_id).catch(() => undefined);

        const output = await env.handoffs.wait({
          tabId: tab_id,
          message,
          timeout: timeout_ms ?? HANDOFF_TIMEOUT,
          signal,
          ...(run.sessionID ? { sessionID: run.sessionID } : {}),
        });

        return { output };
      },
    }),
  ];
}
