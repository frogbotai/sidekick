import type { Point } from '../worker/types';
import { markOwn } from './dom';

const CSS = `
:host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.fb-glow { position: fixed; inset: 0; }
.fb-glow__ring { position: fixed; inset: 0; padding: 3px; border-radius: 0; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
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
}

/**
 * The agent's cursor, glow and Stop button, in a closed shadow root on `<html>`. `glowCss` styles
 * the ring's `fb-glow` classes; Stop accepts only trusted clicks, and the host comes back if the
 * page removes it while a run is on.
 */
export function createIndicator(onStop: () => void, glowCss = ''): Indicator {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const glow = document.createElement('div');
  const ring = document.createElement('div');
  const cursor = document.createElement('div');
  const stop = document.createElement('button');
  let shown = false;

  markOwn(host);
  root.adoptedStyleSheets = [sheetOf(glowCss), sheetOf(CSS)];
  glow.className = 'fb-glow';
  ring.className = 'fb-glow__ring';
  glow.append(ring);
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

  root.append(glow, cursor, stop);

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
  };
}
