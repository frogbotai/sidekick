import type { HandoffCard, Point } from '../worker/types';
import { markOwn } from './dom';

const CSS = `
:host { all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; pointer-events: none !important; z-index: 2147483647 !important; visibility: visible !important; opacity: 1 !important; }
.overlay { position: fixed; inset: 0; pointer-events: none; opacity: 0; animation: fb-overlay-in 0.8s ease-in-out forwards; }
.overlay__tint { position: absolute; inset: 6px; background-color: rgba(16, 24, 40, 0.25); box-shadow: inset 0 0 16px rgba(58, 207, 106, 0.6), inset 0 0 28px rgba(58, 207, 106, 0.4), inset 0 0 40px rgba(31, 158, 74, 0.3); }
.overlay__frame { position: absolute; inset: 0; overflow: hidden; clip-path: polygon(0% 0%, 0% 6px, calc(100% - 6px) 6px, calc(100% - 6px) calc(100% - 6px), 6px calc(100% - 6px), 6px 6px, 0% 6px, 0% 100%, 100% 100%, 100% 0%); box-shadow: inset 0 0 12px rgba(58, 207, 106, 0.6), inset 0 0 24px rgba(58, 207, 106, 0.4), inset 0 0 36px rgba(31, 158, 74, 0.3); filter: drop-shadow(0 0 12px rgba(58, 207, 106, 0.6)) drop-shadow(0 0 24px rgba(58, 207, 106, 0.4)) drop-shadow(0 0 36px rgba(31, 158, 74, 0.3)); }
.overlay__gradient { position: absolute; top: -100%; left: -100%; width: 300%; height: 300%; background: conic-gradient(from 0deg at 50% 50%, transparent 0deg, transparent 150deg, #1f9e4a 180deg, #3acf6a 210deg, #8ee8ab 240deg, #d4f7df 270deg, #8ee8ab 300deg, #3acf6a 330deg, #1f9e4a 360deg); animation: fb-overlay-rotate 8s linear infinite; filter: drop-shadow(0 0 12px rgba(58, 207, 106, 0.6)) drop-shadow(0 0 24px rgba(58, 207, 106, 0.4)) drop-shadow(0 0 36px rgba(31, 158, 74, 0.3)); }
@keyframes fb-overlay-rotate { to { transform: rotate(360deg); } }
@keyframes fb-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .overlay__gradient { animation: none; } }
.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; transform: translate(-100px, -100px); transition: transform 200ms ease-out; }
.overlay--waiting .overlay__tint, .overlay--waiting ~ .cursor { display: none; }
.handoff { position: fixed; inset: auto auto 64px 50%; transform: translateX(-50%); margin: 0; width: min(360px, calc(100vw - 32px)); box-sizing: border-box; overflow: visible; pointer-events: auto; font: 14px/1.4 Inter, system-ui, sans-serif; color: #111827; background: #fff; border: 1px solid #d1d5db; border-radius: 12px; padding: 16px; box-shadow: 0 8px 30px rgba(5, 9, 18, 0.25); }
.handoff__title { margin: 0 0 4px; font-weight: 600; }
.handoff__message { margin: 0 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.handoff__continue { display: block; margin-left: auto; font: 700 14px/20px Inter, system-ui, sans-serif; color: #fff; background: #16a34a; border: 0; border-radius: 9999px; padding: 8px 16px; cursor: pointer; }
.handoff__continue:hover { background: color-mix(in srgb, #16a34a, #000000 12%); }
@media (prefers-color-scheme: dark) { .handoff { color: #f9fafb; background: #1f2937; border-color: #374151; } }
.stop { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: auto; font: 700 14px/20px Inter, system-ui, sans-serif; color: #ffffff; background: #b91c1c; border: 0; border-radius: 9999px; padding: 8px 16px; cursor: pointer; box-shadow: 0 2px 10px rgba(5, 9, 18, 0.3); }
.stop:hover { background: color-mix(in srgb, #b91c1c, #ffffff 16%); }
`;

const SVG = 'http://www.w3.org/2000/svg';

function arrow() {
  const svg = document.createElementNS(SVG, 'svg');
  const path = document.createElementNS(SVG, 'path');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  path.setAttribute('d', 'M3 2l7.5 19 2.6-7.9L21 10.5z');
  path.setAttribute('fill', '#3acf6a');
  path.setAttribute('stroke', '#04210d');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  return svg;
}

function sheetOf(css: string) {
  const sheet = new CSSStyleSheet();

  sheet.replaceSync(css);

  return sheet;
}

export interface Indicator {
  set(state: { visible?: boolean; cursor?: Point; hidden?: boolean }): void;
  /** Shows the handoff card over the page, in the top layer, or removes it with `null`. */
  handoff(card: HandoffCard | null): void;
  visible(): boolean;
  /** Whether a viewport point is on the Stop button, edges included, while it's shown. */
  covers(point: Point): boolean;
}

export interface IndicatorActions {
  onStop: () => void;
  onContinue: (id: string) => void;
}

/**
 * The agent's cursor, page overlay, Stop button and handoff card, in a closed shadow root on
 * `<html>`. The overlay is the old Sidekick's: a dim tint inside a 6px frame whose FrogBot green
 * highlight turns round the page. Stop and Continue accept only trusted clicks, the host comes
 * back if the page removes it while a run or handoff is on, and the card rises back above a
 * page's own popovers. A modal dialog makes the rest of the page inert, top layer included, so
 * while one is open the host moves inside it.
 */
export function createIndicator({ onStop, onContinue }: IndicatorActions): Indicator {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const overlay = document.createElement('div');
  const tint = document.createElement('div');
  const frame = document.createElement('div');
  const gradient = document.createElement('div');
  const cursor = document.createElement('div');
  const stop = document.createElement('button');
  const card = document.createElement('div');
  const title = document.createElement('p');
  const message = document.createElement('p');
  const proceed = document.createElement('button');
  let shown = false;
  let waiting: HandoffCard | null = null;
  const sheet = sheetOf(CSS);
  const hide = sheetOf(':host { visibility: hidden !important; }');

  markOwn(host);
  root.adoptedStyleSheets = [sheet];
  overlay.className = 'overlay';
  tint.className = 'overlay__tint';
  frame.className = 'overlay__frame';
  gradient.className = 'overlay__gradient';
  frame.append(gradient);
  overlay.append(tint, frame);
  cursor.className = 'cursor';
  cursor.append(arrow());
  stop.className = 'stop';
  stop.type = 'button';
  stop.textContent = 'Stop Sidekick';

  stop.addEventListener('click', (event) => {
    if (!event.isTrusted) return;

    event.stopPropagation();
    onStop();
  });

  card.className = 'handoff';
  card.popover = 'manual';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', 'Sidekick is waiting for you');
  title.className = 'handoff__title';
  title.textContent = 'Sidekick is waiting for you';
  message.className = 'handoff__message';
  proceed.className = 'handoff__continue';
  proceed.type = 'button';
  proceed.textContent = 'Continue';
  card.append(title, message, proceed);

  proceed.addEventListener('click', (event) => {
    if (!event.isTrusted || !waiting) return;

    event.stopPropagation();
    onContinue(waiting.id);
  });

  root.append(overlay, cursor, stop, card);

  const raise = () => {
    if (!waiting || !card.isConnected) return;

    card.hidePopover();
    card.showPopover();
  };

  const modal = () =>
    waiting
      ? [...document.querySelectorAll('dialog[open]')].findLast((dialog) =>
          dialog.matches(':modal'),
        )
      : undefined;

  const restore = new MutationObserver(() => {
    if (place()) raise();
  });

  function place() {
    if (!shown && !waiting) {
      restore.disconnect();
      host.remove();

      return false;
    }

    const parent = modal() ?? document.documentElement;

    if (host.parentNode === parent) return false;

    parent.append(host);
    restore.disconnect();
    restore.observe(document.documentElement, { childList: true });

    if (parent !== document.documentElement) restore.observe(parent, { childList: true });

    return true;
  }

  const onToggle = (event: Event) => {
    if (event.target === card) return;

    if (place() || (event as ToggleEvent).newState === 'open') raise();
  };

  return {
    set: ({ visible, cursor: point, hidden }) => {
      if (visible !== undefined && visible !== shown) {
        shown = visible;

        if (place()) raise();
      }

      if (hidden !== undefined || visible === true) {
        host.style.visibility = hidden ? 'hidden' : '';
        root.adoptedStyleSheets = hidden ? [sheet, hide] : [sheet];
      }

      if (point) cursor.style.transform = `translate(${point.x - 3}px, ${point.y - 2}px)`;
    },
    handoff: (next) => {
      const same = next !== null && waiting?.id === next.id;

      if (!next && waiting) {
        document.removeEventListener('toggle', onToggle, true);

        if (card.isConnected) card.hidePopover();
      } else if (next && !waiting) {
        document.addEventListener('toggle', onToggle, true);
      }

      waiting = next;
      overlay.classList.toggle('overlay--waiting', next !== null);

      if (next) message.textContent = next.message;

      if (place() || !same) raise();
    },
    visible: () => shown && host.isConnected,
    covers: ({ x, y }) => {
      if (!shown || !host.isConnected) return false;

      const rect = stop.getBoundingClientRect();

      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    },
  };
}
