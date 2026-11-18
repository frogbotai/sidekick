import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { messageOf } from '../abort';
import { type BrowserEnv, enter, finish, send, settleAfter, untrusted } from '../env';
import { action, byTab, tabId } from './schema';

function noDialog() {
  return new ToolError(
    'invalid_target',
    'No dialog is open on this tab. dialog get returns null when none is open; carry on without answering one.',
  );
}

/** OpenCode v2's `dialog`: the agent answers every dialog; nothing is answered for it. */
export function dialogTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'dialog',
      description:
        'Read, accept or dismiss the JavaScript dialog (alert, confirm, prompt or “Leave site?”) waiting on a tab. Action results name it in dialog when one opens; nothing else on that tab works until it is answered.',
      input: z
        .object({
          tab_id: tabId,
          action: z.enum(['get', 'accept', 'dismiss']),
          promptText: z
            .string()
            .optional()
            .describe('The text to answer a prompt with; only with accept.'),
        })
        .refine((input) => input.promptText === undefined || input.action === 'accept', {
          message: 'promptText goes only with accept.',
        }),
      output: action,
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, action: answer, promptText }, ctx) => {
        const act = await enter(env, ctx, tab_id, 'input', { dialog: true });
        const pending = env.dialogs.get(tab_id);

        if (answer === 'get') return untrusted(await finish(act, true));

        if (!pending) throw noDialog();

        const output = await settleAfter(act, async (during) => {
          try {
            await send(during, 'Page.handleJavaScriptDialog', {
              accept: answer === 'accept',
              ...(promptText === undefined ? {} : { promptText }),
            });
          } catch (error) {
            if (!/no dialog is showing/i.test(messageOf(error))) throw error;

            env.dialogs.clear(tab_id, pending);

            throw noDialog();
          }

          env.dialogs.clear(tab_id, pending);
        });

        return untrusted(output);
      },
    }),
  ];
}
