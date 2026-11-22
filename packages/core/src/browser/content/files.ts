import { ToolError } from '../../tool/tool';
import type { FileData } from '../worker/types';

function bytesOf(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return bytes;
}

const FILE_INPUT = 'input[type=file]';
const FIELD =
  'input:not([type=button], [type=submit], [type=image], [type=reset]), select, textarea, [contenteditable]';

const MAX_DEPTH = 3;

function isFileInput(element: Element | null | undefined): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === 'file';
}

function fileInputOf(element: Element) {
  if (isFileInput(element)) return element;

  if (element instanceof HTMLLabelElement && element.control) {
    return isFileInput(element.control) ? element.control : undefined;
  }

  if (element.matches(FIELD)) return undefined;

  let scope: Element | null = element;

  for (let depth = 0; scope && scope !== document.body && depth <= MAX_DEPTH; depth++) {
    const found = scope.querySelectorAll(FILE_INPUT);

    if (found.length > 1) return undefined;

    if (isFileInput(found[0])) return found[0];

    scope = scope.parentElement;
  }

  return undefined;
}

/**
 * Claude for Chrome's route: builds `File`s from base64, sets them through a `DataTransfer`, then
 * fires `input` and `change` as a user's pick would. The ref may be the input, its label, or a button
 * with one file input within three levels around it, since styled widgets hide the input. The element
 * is checked before anything is set.
 */
export function setFiles(target: Element, ref: string, files: FileData[]) {
  const element = fileInputOf(target);

  if (!element) {
    throw new ToolError(
      'invalid_target',
      `${ref} isn’t a file input, its label or the button of one. Pass the ref of the upload button or field the file goes to.`,
    );
  }

  if (element.matches(':disabled') || element.closest('fieldset[disabled]')) {
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
