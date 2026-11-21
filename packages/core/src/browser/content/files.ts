import { ToolError } from '../../tool/tool';
import type { FileData } from '../worker/types';

function bytesOf(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

/**
 * Claude for Chrome's route: builds `File`s from base64, sets them through a `DataTransfer`, then
 * fires `input` and `change` as a user's pick would. The element is checked before anything is set.
 */
export function setFiles(element: Element, ref: string, files: FileData[]) {
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw new ToolError(
      'invalid_target',
      `${ref} isn’t a file input. Take a snapshot and pass the ref of the <input type=file>; a styled “Upload” button usually has one hidden beside it.`,
    );
  }

  if (element.disabled) {
    throw new ToolError('invalid_target', `${ref} is disabled. Look for what enables it.`);
  }

  if (files.length > 1 && !element.multiple) {
    throw new ToolError(
      'invalid_input',
      `${ref} takes one file. Send just one, or look for an input that takes several.`,
    );
  }

  const transfer = new DataTransfer();

  for (const file of files) {
    transfer.items.add(new File([bytesOf(file.data)], file.name, { type: file.mimeType }));
  }

  element.files = transfer.files;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  return element.files.length;
}
