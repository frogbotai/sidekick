import type { FileData } from '../browser/worker/types';
import { dataURL } from '../session/request';
import type { SessionMessage, UserPart } from '../session/schema';
import { ToolError } from './tool';

/** Finds a file to resolve `{ attachment }` by name; `undefined` when the chat has none by that name. */
export type AttachmentLookup = (filename: string) => Promise<FileData | undefined>;

function base64Text(text: string) {
  return btoa(
    Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''),
  );
}

function fileOf(part: UserPart, filename: string): FileData | undefined {
  if (part.type === 'data-paste') {
    return { name: filename, mimeType: 'text/plain', data: base64Text(part.data.text) };
  }

  if (part.type !== 'file') return undefined;

  const inline = dataURL(part.url);

  if (!inline) {
    throw new ToolError(
      'invalid_input',
      `“${filename}” isn’t stored in this chat, so it can’t be uploaded. Send the file as base64.`,
    );
  }

  return { name: filename, mimeType: inline.mediaType, data: inline.data };
}

function nameOf(part: UserPart) {
  if (part.type === 'data-paste') return part.data.filename;

  return part.type === 'file' ? part.filename : undefined;
}

/**
 * The newest file the user attached or pasted in `messages` named `filename`, as base64. It fails
 * when that file isn't stored in the chat, rather than falling back to an older one.
 */
export function attachedFile(
  messages: readonly SessionMessage[],
  filename: string,
): FileData | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type !== 'user') continue;

    const part = [...message.parts].reverse().find((each) => nameOf(each) === filename);

    if (part) return fileOf(part, filename);
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
