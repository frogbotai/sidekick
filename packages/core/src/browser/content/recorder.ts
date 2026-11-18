import type { RecordedStep } from '../../protocol';
import { isOwn, parentAcross } from './dom';
import { clip, isChecked, nameOf, REDACT_AUTOCOMPLETE, roleOf, valueOf } from './roles';

const ACTIONABLE = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'option',
  'treeitem',
]);

const NOT_TYPED = /^(checkbox|radio|file|submit|reset|button|image|range|color|hidden)$/;

const PERSONAL =
  /^(name|given-name|additional-name|family-name|email|username|organization|street-address|address-line\d|address-level\d|postal-code|country(-name)?|bday(-day|-month|-year)?|tel(-[a-z-]+)?)$/;

const PERSONAL_TYPE = new Set(['email', 'tel']);

const CONTAINER = new Set(['form', 'dialog', 'alertdialog', 'group', 'region', 'navigation']);

const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

const NEARBY_DEPTH = 6;

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function targetOf(event: Event) {
  const target = event.composedPath()[0];

  return target instanceof Element ? target : undefined;
}

function isNative(element: Element) {
  return (
    element instanceof HTMLSelectElement ||
    element instanceof HTMLOptionElement ||
    (element instanceof HTMLInputElement && /^(checkbox|radio|file)$/.test(element.type))
  );
}

function clickable(start: Element) {
  for (let element: Element | null = start; element; element = parentAcross(element)) {
    if (isOwn(element)) return undefined;

    if (isNative(element)) return undefined;

    const role = roleOf(element);

    if (role && ACTIONABLE.has(role)) return element;
  }

  return undefined;
}

function typedField(start: Element) {
  if (start instanceof HTMLTextAreaElement) return start;

  if (start instanceof HTMLInputElement) return NOT_TYPED.test(start.type) ? undefined : start;

  for (let element: Element | null = start; element; element = parentAcross(element)) {
    if (element instanceof HTMLElement && element.isContentEditable) {
      if (!element.parentElement?.isContentEditable) return element;
    } else {
      return undefined;
    }
  }

  return undefined;
}

function tokensOf(element: Element) {
  return (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
}

function privacyOf(element: Element): string | undefined {
  if (element instanceof HTMLInputElement && element.type === 'password') return 'secret';

  if (REDACT_AUTOCOMPLETE.test(element.getAttribute('autocomplete') ?? '')) return 'secret';

  const token = tokensOf(element).find((entry) => PERSONAL.test(entry));

  if (token) return token;

  if (element instanceof HTMLInputElement && PERSONAL_TYPE.has(element.type)) return element.type;

  return undefined;
}

function segment(element: Element) {
  const tag = element.tagName.toLowerCase();

  if (element.id) return { text: `${tag}#${CSS.escape(element.id)}`, anchored: true };

  const parent = element.parentElement;

  if (!parent) return { text: tag, anchored: false };

  const same = Array.from(parent.children).filter((child) => child.tagName === element.tagName);

  return {
    text: same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(element) + 1})` : tag,
    anchored: false,
  };
}

function hostOf(element: Element) {
  const root = element.getRootNode();

  return root instanceof ShadowRoot ? root.host : null;
}

/** A CSS path to the element; ` >>> ` steps into a shadow root. A hint for ties, never the match. */
export function selectorOf(element: Element): string {
  const scopes: string[] = [];
  let parts: string[] = [];
  let node: Element | null = element;

  while (node) {
    const { text, anchored } = segment(node);
    const up: Element | null = anchored ? null : node.parentElement;

    parts.unshift(text);

    if (up) {
      node = up;
      continue;
    }

    scopes.unshift(parts.join(' > '));
    parts = [];
    node = hostOf(node);
  }

  return scopes.join(' >>> ');
}

function headingIn(element: Element) {
  const heading = element.querySelector(HEADING);

  return heading instanceof HTMLElement ? heading.innerText || heading.textContent || '' : '';
}

/** The name of the nearest labelled container, or else its first heading, clipped. */
export function nearbyOf(element: Element): string {
  let node = parentAcross(element);

  for (let depth = 0; node && depth < NEARBY_DEPTH; depth++, node = parentAcross(node)) {
    if (node === document.body || node === document.documentElement) break;

    const role = roleOf(node);
    const name =
      node instanceof HTMLFieldSetElement
        ? (node.querySelector('legend')?.textContent ?? '')
        : role && CONTAINER.has(role)
          ? nameOf(node, role)
          : (node.getAttribute('aria-label') ?? '');

    const text = name.trim() || headingIn(node);

    if (text.trim()) return clip(text, 60);
  }

  return '';
}

function base(element: Element) {
  const role = roleOf(element) ?? '';

  return {
    frameUrl: location.href,
    role,
    name: nameOf(element, role),
    nearby: nearbyOf(element),
    selector: selectorOf(element),
  };
}

function kept(element: Element, value: string) {
  const privacy = privacyOf(element);

  if (privacy === 'secret') return { redacted: true };

  return { value: privacy ? `<${privacy}>` : value };
}

function selectStep(element: HTMLSelectElement): RecordedStep {
  const privacy = privacyOf(element);
  const labels = Array.from(element.selectedOptions, (option) => option.label || option.text);

  if (privacy === 'secret') return { kind: 'select', ...base(element), redacted: true };

  return { kind: 'select', ...base(element), options: privacy ? [`<${privacy}>`] : labels };
}

function changeStep(element: Field): RecordedStep | undefined {
  if (element instanceof HTMLSelectElement) return selectStep(element);

  if (element instanceof HTMLInputElement && /^(checkbox|radio)$/.test(element.type)) {
    return { kind: 'check', ...base(element), checked: isChecked(element) };
  }

  return undefined;
}

export interface Recorder {
  set(on: boolean): void;
  on(): boolean;
}

/**
 * Records the person's clicks on actionable targets, fills, checks and selects in this frame
 * (sidekick-21, after browse's `demonstrate`). Each step goes to `send` as it happens, so a
 * navigation can't drop it. Passwords and secret fields keep no value; personal fields keep
 * their autocomplete token in place of the value (D3 B).
 */
export function createRecorder(send: (step: RecordedStep) => void): Recorder {
  let recording = false;

  const onClick = (event: Event) => {
    const target = targetOf(event);
    const element = target && clickable(target);

    if (element) send({ kind: 'click', ...base(element) });
  };

  const onInput = (event: Event) => {
    const target = targetOf(event);
    const element = target && !isOwn(target) ? typedField(target) : undefined;

    if (!element) return;

    send({ kind: 'fill', ...base(element), ...kept(element, valueOf(element) ?? '') });
  };

  const onChange = (event: Event) => {
    const target = targetOf(event);

    if (
      !target ||
      isOwn(target) ||
      !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)
    ) {
      return;
    }

    const step = changeStep(target);

    if (step) send(step);
  };

  const listeners = [
    ['click', onClick],
    ['input', onInput],
    ['change', onChange],
  ] as const;

  return {
    set: (on) => {
      if (on === recording) return;

      recording = on;

      for (const [type, listener] of listeners) {
        if (on) document.addEventListener(type, listener, true);
        else document.removeEventListener(type, listener, true);
      }
    },
    on: () => recording,
  };
}
