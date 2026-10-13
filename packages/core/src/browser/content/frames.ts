import { originOf } from '../../tool/url';
import { foreignExtension, frameElements, frameSource } from './dom';

export function frameSources() {
  return frameElements().map(frameSource);
}

/**
 * 271 D1, as Claude for Chrome does it: remove other extensions' frames, then frames Chrome
 * doesn't report (by origin), up to the surplus. Returns the removed sources.
 */
export function stripFrames(reported: string[], surplus: number) {
  const unclaimed = [...reported];
  const removed: string[] = [];
  const candidates = [];

  for (const element of frameElements()) {
    const source = frameSource(element);

    if (foreignExtension(source)) {
      element.remove();
      removed.push(source);

      continue;
    }

    const match = unclaimed.indexOf(originOf(source));

    if (match === -1) candidates.push({ element, source });
    else unclaimed.splice(match, 1);
  }

  for (const { element, source } of candidates.slice(0, Math.max(0, surplus - removed.length))) {
    element.remove();
    removed.push(source);
  }

  return removed;
}
