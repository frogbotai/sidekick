const REDACT_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-[a-z-]+)(\s|$)/i;

export const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'slider',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'spinbutton',
  'focusable',
]);

export const OUTLINE = new Set([
  'heading',
  'img',
  'dialog',
  'navigation',
  'main',
  'alert',
  'form',
  'list',
  'table',
  'row',
]);

const NAMED_BY_CONTENT = new Set([
  'button',
  'link',
  'heading',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'checkbox',
  'radio',
  'switch',
  'focusable',
]);

const INPUT_ROLE: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  number: 'spinbutton',
};

const TAG_ROLE: Record<string, string> = {
  BUTTON: 'button',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  SUMMARY: 'button',
  IFRAME: 'iframe',
  FRAME: 'iframe',
  DIALOG: 'dialog',
  NAV: 'navigation',
  MAIN: 'main',
  FORM: 'form',
  UL: 'list',
  OL: 'list',
  TABLE: 'table',
  TR: 'row',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
};

export function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.trim();

  if (explicit) return explicit.split(/\s+/)[0];

  if (element instanceof HTMLAnchorElement) {
    return element.hasAttribute('href') ? 'link' : undefined;
  }

  if (element instanceof HTMLInputElement) {
    return element.type === 'hidden' ? undefined : (INPUT_ROLE[element.type] ?? 'textbox');
  }

  if (element instanceof HTMLSelectElement && (element.multiple || element.size > 1)) {
    return 'listbox';
  }

  if (element instanceof HTMLImageElement) return element.alt ? 'img' : undefined;

  const tag = TAG_ROLE[element.tagName.toUpperCase()];

  if (tag) return tag;

  if (element instanceof HTMLElement) {
    if (element.isContentEditable && !element.parentElement?.isContentEditable) return 'textbox';

    if (element.hasAttribute('tabindex') && element.tabIndex >= 0) return 'focusable';
  }

  return undefined;
}

/** Password fields and the autocomplete values Claude for Chrome hides: their values never leave the page. */
export function isRedacted(element: Element) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (element instanceof HTMLInputElement && element.type === 'password') return true;

  return REDACT_AUTOCOMPLETE.test(element.getAttribute('autocomplete') ?? '');
}

export function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function labelled(element: Element) {
  const ids = element.getAttribute('aria-labelledby');

  if (!ids) return '';

  const root = element.getRootNode();
  const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;

  return ids
    .split(/\s+/)
    .map((id) => scope.getElementById(id)?.textContent ?? '')
    .join(' ');
}

function labels(element: Element) {
  if (!(
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  )) {
    return '';
  }

  return Array.from(element.labels ?? [], (label) => label.textContent ?? '').join(' ');
}

const BUTTON_INPUTS = new Set(['submit', 'reset', 'button']);

export function nameOf(element: Element, role: string | undefined): string {
  for (const text of [
    element.getAttribute('aria-label') ?? '',
    labelled(element),
    labels(element),
  ]) {
    if (text.trim()) return clip(text, 80);
  }

  if (
    element instanceof HTMLInputElement &&
    BUTTON_INPUTS.has(element.type) &&
    element.value.trim()
  ) {
    return clip(element.value, 80);
  }

  const attribute =
    element.getAttribute('alt') ??
    element.getAttribute('title') ??
    element.getAttribute('placeholder');

  if (attribute) return clip(attribute, 80);

  if (!role || !NAMED_BY_CONTENT.has(role) || !(element instanceof HTMLElement)) return '';

  return clip(element.innerText || element.textContent || '', 80);
}

export function valueOf(element: Element): string | undefined {
  if (element instanceof HTMLInputElement) {
    return /^(checkbox|radio|submit|reset|button|image)$/.test(element.type)
      ? undefined
      : element.value;
  }

  if (element instanceof HTMLTextAreaElement) return element.value;

  if (element instanceof HTMLSelectElement) {
    return Array.from(element.selectedOptions, (option) => option.label || option.text).join(', ');
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    return element.innerText || element.textContent || '';
  }

  return undefined;
}

export function statesOf(element: Element) {
  const states: string[] = [];

  if (element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type)) {
    if (element.checked) states.push('checked');
  } else if (element.getAttribute('aria-checked') === 'true') {
    states.push('checked');
  }

  const disabled = 'disabled' in element && element.disabled === true;

  if (disabled || element.getAttribute('aria-disabled') === 'true') states.push('disabled');

  const expanded = element.getAttribute('aria-expanded');

  if (expanded) states.push(`expanded=${expanded}`);

  if (element.getAttribute('aria-selected') === 'true') states.push('selected');

  return states.length > 0 ? ` (${states.join(', ')})` : '';
}

/** What a ref must still match before acting: role, name and link target. */
export interface Fingerprint {
  role: string;
  name: string;
  href: string;
}

export function fingerprintOf(element: Element): Fingerprint {
  const role = roleOf(element);

  return {
    role: role ?? '',
    name: nameOf(element, role),
    href: element.getAttribute('href') ?? '',
  };
}
