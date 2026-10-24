import { contains, describe, dialogElements, frameIdOf, isFrame, isOwn, shadowOf } from './dom';
import type { Refs } from './refs';
import {
  clip,
  fingerprintOf,
  INTERACTIVE,
  isRedacted,
  nameOf,
  OUTLINE,
  roleOf,
  statesOf,
  valueOf,
} from './roles';

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG']);

const MAX_NODES = 200_000;

/** One outline line; `frame` marks a child frame the worker reads and nests under it. */
export interface Line {
  depth: number;
  text: string;
  frame?: number;
  redacted?: boolean;
}

export interface FrameSnapshot {
  title: string;
  lines: Line[];
  truncated: boolean;
}

export interface SnapshotOptions {
  refs: Refs;
  scope: 'viewport' | 'page';
  root?: Element;
  /** The root's ref, for the line that names a dialog open outside it. */
  rootRef?: string;
  maxChars: number;
}

interface Band {
  top: number;
  bottom: number;
}

function hidden(element: Element) {
  if (typeof element.checkVisibility !== 'function') return false;

  if (element.checkVisibility({ visibilityProperty: true })) return false;

  return getComputedStyle(element).display !== 'contents';
}

function childNodes(node: Element | Document | ShadowRoot): Node[] {
  if (node instanceof HTMLSlotElement) {
    const assigned = node.assignedNodes({ flatten: true });

    return assigned.length > 0 ? assigned : Array.from(node.childNodes);
  }

  if (node instanceof Element) {
    const shadow = shadowOf(node);

    if (shadow) return Array.from(shadow.childNodes);
  }

  return Array.from(node.childNodes);
}

function placement(element: Element, band: Band | undefined): 'above' | 'below' | 'in' {
  if (!band) return 'in';

  const rect = element.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) return 'in';

  if (rect.bottom < band.top) return 'above';

  if (rect.top > band.bottom) return 'below';

  return 'in';
}

function more(count: number, where: 'above' | 'below') {
  return `… ${count} more item${count === 1 ? '' : 's'} ${where}`;
}

function fieldLine(element: Element, role: string, ref: string) {
  const raw = valueOf(element);
  const redacted = isRedacted(element);
  const value = redacted
    ? ' value=[redacted]'
    : raw
      ? ` value=${JSON.stringify(clip(raw, 60))}`
      : '';

  const name = JSON.stringify(nameOf(element, role));

  return { text: `- ${role} ${name}${value}${statesOf(element)} [${ref}]`, redacted };
}

/**
 * Reads one frame as an outline, open dialogs first so a short read still reaches them. The
 * viewport scope keeps elements within one viewport height of the screen and summarises the rest
 * of each container; `maxChars` caps the text.
 */
export function snapshotFrame({
  refs,
  scope,
  root,
  rootRef,
  maxChars,
}: SnapshotOptions): FrameSnapshot {
  const band =
    scope === 'viewport' && !root ? { top: -innerHeight, bottom: innerHeight * 2 } : undefined;

  const dialogs = dialogElements().filter((dialog) => !hidden(dialog));
  const moved = new Set(root ? [] : dialogs);
  const lines: Line[] = [];
  let chars = 0;
  let nodes = 0;
  let truncated = false;

  const emit = (line: Line) => {
    if (truncated) return;

    chars += line.depth * 2 + line.text.length + 1;

    if (chars > maxChars) {
      truncated = true;

      return;
    }

    lines.push(line);
  };

  const walkChildren = (node: Element | Document | ShadowRoot, depth: number, inside: boolean) => {
    let above = 0;
    let below = 0;
    const kept: Node[] = [];

    for (const child of childNodes(node)) {
      if (child instanceof Element && moved.has(child)) continue;

      const where = child instanceof Element ? placement(child, band) : 'in';

      if (where === 'above') above++;
      else if (where === 'below') below++;
      else kept.push(child);
    }

    if (above > 0) emit({ depth, text: more(above, 'above') });

    for (const child of kept) walk(child, depth, inside);

    if (below > 0) emit({ depth, text: more(below, 'below') });
  };

  const walk = (node: Node, depth: number, inside: boolean) => {
    if (truncated) return;

    if (++nodes > MAX_NODES) {
      truncated = true;

      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = inside ? '' : clip(node.textContent ?? '', 100);

      if (text.length > 1) emit({ depth, text: `- text ${JSON.stringify(text)}` });

      return;
    }

    if (!(node instanceof Element) || isOwn(node) || SKIP.has(node.tagName.toUpperCase())) return;

    if (hidden(node)) return;

    if (isFrame(node)) {
      const name = JSON.stringify(nameOf(node, 'iframe') || describe(node));
      const frame = frameIdOf(node);

      emit(
        frame === undefined
          ? { depth, text: `- iframe ${name} (not readable)` }
          : { depth, text: `- iframe ${name}`, frame },
      );

      return;
    }

    const role = roleOf(node);

    if (role && INTERACTIVE.has(role)) {
      const ref = refs.ref(node, fingerprintOf(node));
      const { text, redacted } = fieldLine(node, role, ref);

      emit(redacted ? { depth, text, redacted } : { depth, text });
      walkChildren(node, depth + 1, true);

      return;
    }

    if (role && OUTLINE.has(role)) {
      const level = /^H(\d)$/i.exec(node.tagName)?.[1];
      const name = role === 'list' || role === 'table' || role === 'row' ? '' : nameOf(node, role);

      emit({
        depth,
        text: `- ${role}${level ? ` ${level}` : ''}${name ? ` ${JSON.stringify(name)}` : ''}`,
      });

      walkChildren(node, depth + 1, inside || role === 'heading' || role === 'img');

      return;
    }

    walkChildren(node, depth, inside);
  };

  if (root) {
    walk(root, 0, false);

    for (const dialog of dialogs) {
      if (contains(dialog, root) || contains(root, dialog)) continue;

      const role = roleOf(dialog) ?? 'dialog';
      const name = nameOf(dialog, role);
      const label = name ? `${role} ${JSON.stringify(name)}` : role;

      lines.push({
        depth: 0,
        text: `… ${label} is open outside ${rootRef ?? 'this element'}. Snapshot without a ref to read it.`,
      });
    }
  } else {
    for (const dialog of moved) walk(dialog, 0, false);

    if (document.body) walkChildren(document.body, 0, false);
  }

  return { title: document.title, lines, truncated };
}
