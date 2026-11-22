import { ToolError } from '../../tool/tool';
import type { Rgba } from './types';

export interface PixelDiff {
  changed: number;
  /** Unchanged pixels faded to gray, changed pixels red. */
  image: Rgba;
}

export const DIFF_THRESHOLD = 0.1;

const MAX_DELTA = 35_215;

function blend(color: number, alpha: number) {
  return 255 + (color - 255) * alpha;
}

function y(r: number, g: number, b: number) {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}

function i(r: number, g: number, b: number) {
  return r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
}

function q(r: number, g: number, b: number) {
  return r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
}

function pixel(data: Uint8ClampedArray, offset: number): [number, number, number] {
  const [r = 0, g = 0, b = 0, a = 255] = data.subarray(offset, offset + 4);

  if (a === 255) return [r, g, b];

  const alpha = a / 255;

  return [blend(r, alpha), blend(g, alpha), blend(b, alpha)];
}

function delta(before: Uint8ClampedArray, after: Uint8ClampedArray, offset: number) {
  const [r1, g1, b1] = pixel(before, offset);
  const [r2, g2, b2] = pixel(after, offset);
  const dy = y(r1, g1, b1) - y(r2, g2, b2);
  const di = i(r1, g1, b1) - i(r2, g2, b2);
  const dq = q(r1, g1, b1) - q(r2, g2, b2);

  return 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
}

function same(before: Uint8ClampedArray, after: Uint8ClampedArray, offset: number) {
  for (let index = offset; index < offset + 4; index++) {
    if (before[index] !== after[index]) return false;
  }

  return true;
}

/**
 * Per-pixel YIQ colour distance, ported from browse's `pixeldiff.rs` (pixelmatch's metric).
 * `threshold` (0 to 1) is how far a pixel's colour may move before it counts as changed, not a
 * share of the image. Images of different sizes are refused, never resized.
 */
export function pixelDiff(before: Rgba, after: Rgba, threshold = DIFF_THRESHOLD): PixelDiff {
  if (before.width !== after.width || before.height !== after.height) {
    throw new ToolError(
      'size_mismatch',
      `The screenshots differ in size: baseline ${before.width}×${before.height}, now ${after.width}×${after.height}. Capture both at the same viewport and scale; images are never resized.`,
    );
  }

  if (!(threshold >= 0 && threshold <= 1)) {
    throw new RangeError('threshold must be from 0 to 1');
  }

  const max = MAX_DELTA * threshold * threshold;
  const output = new Uint8ClampedArray(before.data.length);
  let changed = 0;

  for (let offset = 0; offset < before.data.length; offset += 4) {
    if (!same(before.data, after.data, offset) && delta(before.data, after.data, offset) > max) {
      changed++;
      output.set([255, 0, 0, 255], offset);
      continue;
    }

    const [r = 0, g = 0, b = 0, a = 255] = before.data.subarray(offset, offset + 4);
    const value = Math.round(blend(y(r, g, b), (0.1 * a) / 255));

    output.set([value, value, value, 255], offset);
  }

  return { changed, image: { width: before.width, height: before.height, data: output } };
}
