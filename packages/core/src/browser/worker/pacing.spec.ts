import { describe, expect, it } from 'vitest';

import { createPacer, MAX_PENDING_FRAMES, type PacedFrame } from './pacing';

function setup({ frameRate = 10, hold = false } = {}) {
  const written: PacedFrame[] = [];
  const waiting: (() => void)[] = [];

  const pacer = createPacer({
    frameRate,
    write: (frame) => {
      written.push(frame);

      return hold ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
  });

  const release = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };

  return { pacer, written, release };
}

const none = () => Promise.resolve(undefined);

describe('createPacer', () => {
  it('puts the first frame at 0 and snaps later ones to the frame grid', async () => {
    const { pacer, written } = setup();

    pacer.push({ data: 'a', at: 30 });
    pacer.push({ data: 'b', at: 120 });
    pacer.push({ data: 'c', at: 340 });
    await pacer.finish(500, none);

    expect(written.map(({ data }) => data)).toEqual(['a', 'b', 'c']);
    expect(written.map(({ timestamp }) => timestamp)).toEqual([0, 0.1, 0.3]);
    expect(written.map(({ duration }) => duration)).toEqual([0.1, 0.2, 0.2]);
  });

  it('coalesces frames on one slot to the newest', async () => {
    const { pacer, written } = setup();

    pacer.push({ data: 'a', at: 0 });
    pacer.push({ data: 'b', at: 110 });
    pacer.push({ data: 'c', at: 130 });
    pacer.push({ data: 'd', at: 140 });
    await pacer.finish(300, none);

    expect(written.map(({ data }) => data)).toEqual(['a', 'd']);

    expect(pacer.quality(300)).toMatchObject({
      frames_captured: 4,
      frames_written: 2,
      frames_coalesced: 2,
      frames_dropped: 0,
    });
  });

  it(`drops and counts frames past ${MAX_PENDING_FRAMES} pending writes, and never the final one`, async () => {
    const { pacer, written, release } = setup({ hold: true });
    const total = MAX_PENDING_FRAMES + 6;

    for (let index = 0; index <= total; index += 1) {
      pacer.push({ data: `f${index}`, at: index * 100 });
    }

    expect(written).toHaveLength(MAX_PENDING_FRAMES);

    const finished = pacer.finish((total + 1) * 100, none);

    await Promise.resolve();
    release();
    await finished;

    expect(written.at(-1)).toMatchObject({ data: `f${total}` });

    expect(pacer.quality((total + 1) * 100)).toMatchObject({
      frames_captured: total + 1,
      frames_written: MAX_PENDING_FRAMES + 1,
      frames_dropped: total - MAX_PENDING_FRAMES,
    });
  });

  it('writes the held frame on finish, shown until the end', async () => {
    const { pacer, written } = setup();

    pacer.push({ data: 'a', at: 0 });
    await pacer.finish(2_000, () => Promise.resolve('unused'));

    expect(written).toEqual([{ data: 'a', timestamp: 0, duration: 2 }]);
  });

  it('writes one screenshot as the final frame when no frame came', async () => {
    const { pacer, written } = setup();

    await pacer.finish(1_000, () => Promise.resolve('still'));

    expect(written).toEqual([{ data: 'still', timestamp: 0, duration: 1 }]);
  });

  it('counts a failed write as dropped', async () => {
    const pacer = createPacer({ frameRate: 10, write: () => Promise.reject(new Error('gone')) });

    pacer.push({ data: 'a', at: 0 });
    await pacer.finish(100, none);

    expect(pacer.quality(100)).toMatchObject({ frames_written: 0, frames_dropped: 1, fps: 0 });
  });

  it('reports the video’s frame rate, not the screencast’s', async () => {
    const { pacer } = setup();

    for (let index = 0; index < 60; index += 1) {
      pacer.push({ data: String(index), at: (index * 1000) / 60 });
    }

    await pacer.finish(1_000, none);

    expect(pacer.quality(1_000).frames_written).toBeLessThanOrEqual(11);
    expect(pacer.quality(1_000).fps).toBeLessThanOrEqual(10);
  });

  it('reports the achieved frame rate and screenshot fallback', () => {
    const { pacer } = setup();

    pacer.push({ data: 'a', at: 0 });
    pacer.push({ data: 'b', at: 500, fallback: true });
    pacer.push({ data: 'c', at: 900 });

    expect(pacer.quality(2_000)).toMatchObject({ fps: 1.5, screenshot_fallback: true });
  });
});
