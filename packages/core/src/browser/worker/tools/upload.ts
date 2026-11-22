import { z } from 'zod';

import { defineTool, ToolError } from '../../../tool/tool';
import { race } from '../abort';
import { type BrowserEnv, enter, inspectTarget, recheck, settleAfter, untrusted } from '../env';
import type { FileData } from '../types';
import { action, byTab, ref, tabId } from './schema';

/** The most one call may upload, as OpenCode v2's browser plugin allows. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const SCRIPT_SET_FILES =
  'Some sites ignore files set by a script. Take a snapshot to check the page took them, like a file name or preview next to the field.';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL = /^data:[^,]*;base64,/i;

const sent = z.object({
  name: z.string().min(1).describe('The file name the page sees, like resume.pdf.'),
  mimeType: z.string().min(1).describe('Like application/pdf or image/png.'),
  data: z.string().describe('The file’s bytes, base64-encoded.'),
});

const attached = z.object({
  attachment: z
    .string()
    .min(1)
    .describe('The name of a file the user attached or pasted in this chat, as the chat shows it.'),
});

function invalid(message: string) {
  return new ToolError('invalid_input', message);
}

function bytesIn(data: string) {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;

  return (data.length / 4) * 3 - padding;
}

/** Checks every file before the page is touched: none, a chat name left unresolved, bad base64, or over 5 MiB. */
export function uploadFiles(files: (z.infer<typeof sent> | z.infer<typeof attached>)[]) {
  if (files.length === 0) {
    throw invalid('Send at least one file, as { name, mimeType, data } or { attachment }.');
  }

  const checked = files.map((file): FileData => {
    if ('attachment' in file) {
      throw invalid(
        `“${file.attachment}” can’t be read here: only a chat in Sidekick’s panel can attach its files. Send the file as base64 instead.`,
      );
    }

    const data = file.data.replace(DATA_URL, '').replace(/\s+/g, '');

    if (data.length % 4 !== 0 || !BASE64.test(data)) {
      throw invalid(`${file.name}’s data isn’t valid base64. Encode the file’s bytes as base64.`);
    }

    return { name: file.name, mimeType: file.mimeType, data };
  });

  const total = checked.reduce((sum, file) => sum + bytesIn(file.data), 0);

  if (total > MAX_UPLOAD_BYTES) {
    const mib = (total / 1024 / 1024).toFixed(1);

    throw invalid(
      `The files total ${mib} MiB; one upload takes at most 5 MiB. Send fewer or smaller files.`,
    );
  }

  return checked;
}

export function uploadTools(env: BrowserEnv) {
  return [
    defineTool({
      id: 'upload',
      description:
        'Attach files to a file input, by the ref of the input, its label or its upload button (the input itself is often hidden), then fire its input and change events. Each file is base64 with its name and type, or { attachment } naming a file the user attached or pasted in this chat. At most 5 MiB per call.',
      input: z.object({
        tab_id: tabId,
        ref,
        files: z.array(z.union([sent, attached])).describe('One or more files.'),
      }),
      output: action.extend({
        files: z.number().describe('How many files the input holds now.'),
        note: z.string(),
      }),
      permission: 'input',
      lock: byTab,
      execute: async ({ tab_id, ref: element, files }, ctx) => {
        const checked = uploadFiles(files);
        const act = await enter(env, ctx, tab_id, 'input');

        await inspectTarget(act, element);
        await recheck(act);
        await act.env.sessions.ensure(act.tabId, act.signal);

        let held = 0;

        const output = await settleAfter(act, async (during) => {
          held = await race(env.page.setFiles(tab_id, element, checked), during.signal);
        });

        return untrusted({ ...output, files: held, note: SCRIPT_SET_FILES });
      },
    }),
  ];
}
