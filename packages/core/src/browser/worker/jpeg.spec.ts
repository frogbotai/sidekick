import { describe, expect, it } from 'vitest';

import { fakeJpeg } from './fakes';
import { jpegSize } from './jpeg';

function base64(bytes: number[]) {
  return btoa(String.fromCharCode(...bytes));
}

describe('jpegSize', () => {
  it('reads the width and height from the start-of-frame marker', () => {
    expect(jpegSize(fakeJpeg({ width: 1210, height: 933 }))).toEqual({ width: 1210, height: 933 });
  });

  it('skips the segments before the frame, as Chrome’s JFIF header', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00];
    const frame = [...atob(fakeJpeg({ width: 800, height: 600 }))].map((char) =>
      char.charCodeAt(0),
    );

    const bytes = [0xff, 0xd8, ...app0, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, ...frame.slice(2)];

    expect(jpegSize(base64(bytes))).toEqual({ width: 800, height: 600 });
  });

  it('gives undefined for data that isn’t a JPEG', () => {
    expect(jpegSize('SU1H')).toBeUndefined();
    expect(jpegSize('not base64!')).toBeUndefined();
    expect(jpegSize(base64([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
  });
});
