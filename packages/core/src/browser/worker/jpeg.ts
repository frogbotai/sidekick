import type { Size } from './types';

const STANDALONE = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function frameMarker(marker: number) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function bytesOf(base64: string) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

    return bytes;
  } catch {
    return undefined;
  }
}

/** A base64 JPEG's real width and height, from its start-of-frame marker; `undefined` if it has none. */
export function jpegSize(base64: string): Size | undefined {
  const bytes = bytesOf(base64);

  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let index = 2;

  while (index + 3 < bytes.length) {
    if (bytes[index] !== 0xff) return undefined;

    const marker = bytes[index + 1] ?? 0;

    if (marker === 0xff) {
      index++;
      continue;
    }

    if (STANDALONE.has(marker)) {
      index += 2;
      continue;
    }

    if (frameMarker(marker)) {
      if (index + 8 >= bytes.length) return undefined;

      const height = ((bytes[index + 5] ?? 0) << 8) | (bytes[index + 6] ?? 0);
      const width = ((bytes[index + 7] ?? 0) << 8) | (bytes[index + 8] ?? 0);

      return width > 0 && height > 0 ? { width, height } : undefined;
    }

    index += 2 + (((bytes[index + 2] ?? 0) << 8) | (bytes[index + 3] ?? 0));
  }

  return undefined;
}
