import {
  BufferTarget,
  canEncodeVideo,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type VideoCodec,
} from 'mediabunny';

const CODECS: VideoCodec[] = ['avc', 'vp9'];

export interface Video {
  /** One JPEG, shown from `timestamp` for `duration` seconds; call in timestamp order. */
  frame(input: { data: string; timestamp: number; duration: number }): Promise<void>;
  finish(): Promise<{ blob: Blob; codec: VideoCodec; width: number; height: number }>;
  cancel(): Promise<void>;
}

interface Track {
  canvas: OffscreenCanvas;
  draw: OffscreenCanvasRenderingContext2D;
  output: Output<Mp4OutputFormat, BufferTarget>;
  source: CanvasSource;
  codec: VideoCodec;
}

function even(size: number) {
  return Math.max(2, Math.floor(size / 2) * 2);
}

async function decode(data: string) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

async function open(frameRate: number, width: number, height: number): Promise<Track> {
  const canvas = new OffscreenCanvas(width, height);
  const draw = canvas.getContext('2d');

  if (!draw) throw new Error('No 2D canvas for the recording');

  const checks = await Promise.all(
    CODECS.map((codec) =>
      canEncodeVideo(codec, { width, height, frameRate, quality: QUALITY_HIGH }),
    ),
  );

  const codec = CODECS.find((_, index) => checks[index]);

  if (!codec) throw new Error('This browser can’t encode H.264 or VP9 video');

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH });

  output.addVideoTrack(source, { frameRate });
  await output.start();

  return { canvas, draw, output, source, codec };
}

/**
 * An MP4 built from JPEG frames with WebCodecs and Mediabunny, at the first frame's size rounded
 * to even pixels; a later frame of another size is fitted inside it on black.
 */
export function createVideo(frameRate: number): Video {
  let track: Track | undefined;

  const paint = async ({ data, timestamp, duration }: Parameters<Video['frame']>[0]) => {
    const bitmap = await decode(data);

    try {
      track ??= await open(frameRate, even(bitmap.width), even(bitmap.height));

      const { canvas, draw } = track;
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;

      draw.fillStyle = '#000';
      draw.fillRect(0, 0, canvas.width, canvas.height);

      draw.drawImage(
        bitmap,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
    } finally {
      bitmap.close();
    }

    await track.source.add(timestamp, duration);
  };

  return {
    frame: paint,
    finish: async () => {
      if (!track) throw new Error('The recording caught no frames');

      await track.output.finalize();

      const buffer = track.output.target.buffer;

      if (!buffer) throw new Error('The recording wrote no file');

      return {
        blob: new Blob([buffer], { type: 'video/mp4' }),
        codec: track.codec,
        width: track.canvas.width,
        height: track.canvas.height,
      };
    },
    cancel: async () => {
      await track?.output.cancel();
    },
  };
}
