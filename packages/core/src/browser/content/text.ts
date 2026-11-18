import { htmlToMarkdown } from '../../webfetch/markdown';
import { isOwn } from './dom';
import { isRedacted } from './roles';

const MAIN = 'main, article, [role="main"]';

const PROSE = new Set(['P', 'PRE', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

export interface PageText {
  title: string;
  text: string;
  truncated: boolean;
}

function hidden(element: Element) {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;

  const style = getComputedStyle(element);

  return style.display === 'none' || style.visibility === 'hidden';
}

function visible(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (isOwn(node) || hidden(node)) return false;
  }

  return true;
}

function prose(element: Element) {
  let length = 0;

  for (const child of element.children) {
    if (PROSE.has(child.tagName)) length += child.textContent?.trim().length ?? 0;
  }

  return length;
}

function mainElement(): Element {
  const marked = [...document.querySelectorAll(MAIN)].find(visible);

  if (marked) return marked;

  let best: Element = document.body;
  let most = 0;

  for (const element of document.body.querySelectorAll('*')) {
    const length = prose(element);

    if (length > most && visible(element)) {
      best = element;
      most = length;
    }
  }

  return best;
}

function prune(live: Element, copy: Element) {
  const twins = [...copy.children];

  [...live.children].forEach((child, index) => {
    const twin = twins[index];

    if (!twin) return;

    if (isOwn(child) || isRedacted(child) || hidden(child)) twin.remove();
    else prune(child, twin);
  });
}

function cut(text: string, max: number) {
  if (text.length <= max) return { text, truncated: false };

  const end = text.lastIndexOf('\n', max);

  return { text: text.slice(0, end > max / 2 ? end : max).trimEnd(), truncated: true };
}

/**
 * The main element, or `root`, as markdown: hidden elements, secret fields and Sidekick's own
 * indicator are removed from a copy first, and live field values are never in `outerHTML`.
 */
export function readText({ root, maxChars }: { root?: Element; maxChars: number }): PageText {
  const live = root ?? mainElement();
  const copy = live.cloneNode(true);

  if (!(copy instanceof Element)) return { title: document.title, text: '', truncated: false };

  prune(live, copy);

  return { title: document.title, ...cut(htmlToMarkdown(copy.outerHTML, location.href), maxChars) };
}
