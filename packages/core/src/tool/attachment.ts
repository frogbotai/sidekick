import type { FileData } from '../browser/worker/types';
import { dataURL } from '../session/request';
import type { SessionMessage } from '../session/schema';
import { ToolError } from './tool';

/** Finds a file to resolve `{ attachment }` by name; `undefined` when the chat has none by that name. */
export type AttachmentLookup = (filename: string) => Promise<FileData | undefined>;

/** The newest file the user attached in `messages` named `filename`, as base64. */
export function attachedFile(
  messages: readonly SessionMessage[],
  filename: string,
): FileData | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type !== 'user') continue;

    for (const part of [...message.parts].reverse()) {
      if (part.type !== 'file' || part.filename !== filename) continue;

      const inline = dataURL(part.url);

      if (inline) return { name: filename, mimeType: inline.mediaType, data: inline.data };
    }
  }

  return undefined;
}

function isAttachment(value: object): value is { attachment: string } {
  return 'attachment' in value && typeof value.attachment === 'string';
}

/** `input` with every object naming `{ attachment }` replaced by that chat file's `{ name, mimeType, data }`. */
export async function withAttachments(input: unknown, find: AttachmentLookup): Promise<unknown> {
  if (Array.isArray(input)) return Promise.all(input.map((item) => withAttachments(item, find)));

  if (typeof input !== 'object' || input === null) return input;

  if (isAttachment(input)) {
    const file = await find(input.attachment);

    if (!file) {
      throw new ToolError(
        'invalid_input',
        `No file named “${input.attachment}” is attached to this chat. Use the file name the chat shows, or send the file as base64.`,
      );
    }

    return file;
  }

  const entries = await Promise.all(
    Object.entries(input).map(async ([key, value]) => [key, await withAttachments(value, find)]),
  );

  return Object.fromEntries(entries);
}
