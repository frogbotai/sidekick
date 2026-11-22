import { describe, expect, it } from 'vitest';

import { solid } from './fakes';
import { pixelDiff } from './pixeldiff';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

function pixelAt(data: Uint8ClampedArray, index: number) {
  return [...data.subarray(index * 4, index * 4 + 4)];
}

describe('pixelDiff', () => {
  it('finds nothing in identical images and grays every pixel', () => {
    const result = pixelDiff(
      solid({ width: 4, height: 3 }, [10, 20, 30, 255]),
      solid({ width: 4, height: 3 }, [10, 20, 30, 255]),
    );

    expect(result.changed).toBe(0);
    expect(result.image).toMatchObject({ width: 4, height: 3 });

    for (let index = 0; index < 12; index++) {
      const [r, g, b, a] = pixelAt(result.image.data, index);

      expect([r === g && g === b, a]).toEqual([true, 255]);
      expect(r).toBeGreaterThan(200);
    }
  });

  it('counts one changed pixel and marks it red', () => {
    const before = solid({ width: 4, height: 4 }, WHITE);
    const after = solid({ width: 4, height: 4 }, WHITE);

    after.data.set([0, 0, 0, 255], 5 * 4);

    const result = pixelDiff(before, after);

    expect(result.changed).toBe(1);
    expect(pixelAt(result.image.data, 5)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(result.image.data, 4)).not.toEqual([255, 0, 0, 255]);
  });

  it('ignores a change under the threshold, and counts it at threshold 0', () => {
    const before = solid({ width: 2, height: 2 }, WHITE);
    const after = solid({ width: 2, height: 2 }, WHITE);

    after.data.set([250, 250, 250, 255], 0);

    expect(pixelDiff(before, after).changed).toBe(0);
    expect(pixelDiff(before, after, 0).changed).toBe(1);
    expect(pixelDiff(before, after, 1).changed).toBe(0);
  });

  it('refuses images of different sizes without resizing', () => {
    expect(() =>
      pixelDiff(solid({ width: 2, height: 2 }, WHITE), solid({ width: 3, height: 2 }, WHITE)),
    ).toThrow(
      expect.objectContaining({
        code: 'size_mismatch',
        message: expect.stringContaining('Capture both at the same viewport and scale'),
      }),
    );
  });

  it.each([-0.1, 1.5, Number.NaN])('refuses threshold %s', (threshold) => {
    const image = solid({ width: 1, height: 1 }, WHITE);

    expect(() => pixelDiff(image, image, threshold)).toThrow(RangeError);
  });
});
