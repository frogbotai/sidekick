import type { Point } from '../worker/types';
import { markOwn } from './dom';

const CSS = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.overlay { position: fixed; inset: 0; pointer-events: none; opacity: 0; animation: fb-overlay-in 0.8s ease-in-out forwards; }
.overlay__tint { position: absolute; inset: 6px; background-color: rgba(16, 24, 40, 0.25); box-shadow: inset 0 0 16px rgba(134, 239, 172, 0.6), inset 0 0 28px rgba(147, 197, 253, 0.4), inset 0 0 40px rgba(216, 180, 254, 0.3); }
.overlay__frame { position: absolute; inset: 0; overflow: hidden; clip-path: polygon(0% 0%, 0% 6px, calc(100% - 6px) 6px, calc(100% - 6px) calc(100% - 6px), 6px calc(100% - 6px), 6px 6px, 0% 6px, 0% 100%, 100% 100%, 100% 0%); box-shadow: inset 0 0 12px rgba(134, 239, 172, 0.6), inset 0 0 24px rgba(147, 197, 253, 0.4), inset 0 0 36px rgba(216, 180, 254, 0.3); filter: drop-shadow(0 0 12px rgba(134, 239, 172, 0.6)) drop-shadow(0 0 24px rgba(147, 197, 253, 0.4)) drop-shadow(0 0 36px rgba(216, 180, 254, 0.3)); }
.overlay__gradient { position: absolute; top: -100%; left: -100%; width: 300%; height: 300%; background: conic-gradient(from 0deg at 50% 50%, transparent 0deg, transparent 150deg, #66eb96 180deg, #78b6fc 210deg, #cb9afe 240deg, #f598a2 270deg, #cb9afe 300deg, #78b6fc 330deg, #66eb96 360deg); animation: fb-overlay-rotate 8s linear infinite; filter: drop-shadow(0 0 12px rgba(134, 239, 172, 0.6)) drop-shadow(0 0 24px rgba(147, 197, 253, 0.4)) drop-shadow(0 0 36px rgba(216, 180, 254, 0.3)); }
@keyframes fb-overlay-rotate { to { transform: rotate(360deg); } }
@keyframes fb-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .overlay__gradient { animation: none; } }
.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; transform: translate(-100px, -100px); transition: transform 200ms ease-out; }
.stop { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); pointer-events: auto; font: 600 13px system-ui, sans-serif; color: #fff; background: #b91c1c; border: 0; border-radius: 999px; padding: 8px 16px; cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); }
`;

const SVG = 'http://www.w3.org/2000/svg';

function arrow() {
  const svg = document.createElementNS(SVG, 'svg');
  const path = document.createElementNS(SVG, 'path');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  path.setAttribute('d', 'M3 2l7.5 19 2.6-7.9L21 10.5z');
  path.setAttribute('fill', '#16a34a');
  path.setAttribute('stroke', '#fff');
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
  set(state: { visible?: boolean; cursor?: Point }): void;
  visible(): boolean;
  /** Whether a viewport point is on the Stop button, edges included, while it's shown. */
  covers(point: Point): boolean;
}

/**
 * The agent's cursor, page overlay and Stop button, in a closed shadow root on `<html>`. The
 * overlay is the old Sidekick's: a dim tint inside a 6px frame whose colours turn round the page.
 * Stop
 * accepts only trusted clicks, and the host comes back if the page removes it while a run is on.
 */
export function createIndicator(onStop: () => void): Indicator {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const overlay = document.createElement('div');
  const tint = document.createElement('div');
  const frame = document.createElement('div');
  const gradient = document.createElement('div');
  const cursor = document.createElement('div');
  const stop = document.createElement('button');
  let shown = false;

  markOwn(host);
  root.adoptedStyleSheets = [sheetOf(CSS)];
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

  root.append(overlay, cursor, stop);

  const restore = new MutationObserver(() => {
    if (shown && !host.isConnected) document.documentElement.append(host);
  });

  return {
    set: ({ visible, cursor: point }) => {
      if (visible === true && !shown) {
        shown = true;
        document.documentElement.append(host);
        restore.observe(document.documentElement, { childList: true });
      } else if (visible === false && shown) {
        shown = false;
        restore.disconnect();
        host.remove();
      }

      if (point) cursor.style.transform = `translate(${point.x - 3}px, ${point.y - 2}px)`;
    },
    visible: () => shown && host.isConnected,
    covers: ({ x, y }) => {
      if (!shown || !host.isConnected) return false;

      const rect = stop.getBoundingClientRect();

      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    },
  };
}
