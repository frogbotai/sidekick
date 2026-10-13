import { ToolError } from '../../tool/tool';

function notText(ref: string) {
  return new ToolError(
    'invalid_target',
    `${ref} isn’t a text field. Click it and use press, or pick a textbox from the snapshot.`,
  );
}

function editingHost(element: HTMLElement) {
  let host = element;

  while (host.parentElement?.isContentEditable) host = host.parentElement;

  return host;
}

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

const LIMITED = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

/** The `maxlength` the browser enforces on a text field, or `undefined`. */
export function maxLengthOf(element: Element) {
  const limited =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && LIMITED.has(element.type));

  return limited && element.maxLength >= 0 ? element.maxLength : undefined;
}

export function focusElement(element: Element) {
  if (element instanceof HTMLElement || element instanceof SVGElement) {
    element.focus({ preventScroll: true });
  }
}

/** Playwright's `fill` preparation: select the field's whole contents, so one `insertText` replaces it. */
export function selectContents(element: Element, ref: string) {
  if (isTextField(element)) {
    element.focus({ preventScroll: true });
    element.select();

    return;
  }

  if (!(element instanceof HTMLElement) || !element.isContentEditable) throw notText(ref);

  const host = editingHost(element);
  const range = document.createRange();
  const selection = getSelection();

  range.selectNodeContents(host);
  host.focus({ preventScroll: true });
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function readValue(element: Element, ref: string) {
  if (isTextField(element)) return element.value;

  if (element instanceof HTMLElement && element.isContentEditable) {
    const host = editingHost(element);

    return host.innerText || host.textContent || '';
  }

  throw notText(ref);
}

/** Selects options by value or label, then fires `input` and `change` as a user's choice would. */
export function selectOptions(element: Element, ref: string, values: string[]) {
  if (!(element instanceof HTMLSelectElement)) {
    throw new ToolError('invalid_target', `${ref} isn’t a <select>. Click it to open its options.`);
  }

  const options = Array.from(element.options);

  const chosen = values.flatMap((value) => {
    const option =
      options.find((candidate) => candidate.value === value) ??
      options.find((candidate) => candidate.label.trim() === value.trim());

    return option && !option.disabled ? [option] : [];
  });

  const picked = element.multiple ? chosen : chosen.slice(0, 1);

  if (picked.length === 0) return [];

  for (const option of options) option.selected = picked.includes(option);

  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  return picked.map((option) => option.value);
}
