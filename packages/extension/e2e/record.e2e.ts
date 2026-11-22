import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserContext } from '@playwright/test';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';

import { expect, test } from './fixtures';

interface RecordingReport {
  file: string;
  codec: string;
  bytes: number;
  width: number;
  height: number;
  frames_captured: number;
  frames_written: number;
  frames_dropped: number;
}

async function newestDownload(context: BrowserContext) {
  const worker = context.serviceWorkers()[0];

  if (!worker) throw new Error('No service worker');

  let found: { path: string; state: string; mime: string; bytes: number } | undefined;

  await expect
    .poll(async () => {
      found = await worker.evaluate(async () => {
        const [item] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });

        return (
          (item?.byExtensionId === chrome.runtime.id && {
            path: item.filename,
            state: item.state,
            mime: item.mime,
            bytes: item.fileSize,
          }) ||
          undefined
        );
      });

      return found?.state;
    })
    .toBe('complete');

  if (!found) throw new Error('No download');

  return { ...found, file: await readFile(found.path) };
}

async function videoOf(bytes: Buffer) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  const track = await input.getPrimaryVideoTrack();

  if (!track) throw new Error('No video track');

  const stats = await track.computePacketStats();

  return {
    format: (await input.getFormat()).name,
    codec: track.codec,
    width: track.displayWidth,
    height: track.displayHeight,
    frames: stats.packetCount,
    duration: await track.computeDuration(),
  };
}

interface DiffOutput {
  width: number;
  height: number;
  changed_pixels: number;
  changed_share: number;
}

test('screenshot_diff finds no change on a still page, then the pixels a page change moved (sidekick-19)', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/color.html`);

  const run = await sidekick.start(page);

  await run.call('screenshot');

  const shot = await run.call<{ width: number; height: number }>('screenshot', { name: 'before' });
  const still = await run.call<DiffOutput>('screenshot_diff', { baseline: 'before' });

  expect(still).toMatchObject({ width: shot.width, height: shot.height, changed_pixels: 0 });

  await page.evaluate(() => {
    const box = document.createElement('div');

    box.style.cssText =
      'position:fixed;left:40px;top:40px;width:100px;height:100px;background:#fff';

    document.body.append(box);
  });

  const reply = await run.reply('screenshot_diff', { baseline: 'before' });

  if ('error' in reply) throw new Error(reply.error.message);

  const changed = reply.ok as DiffOutput;

  expect(changed.changed_pixels).toBeGreaterThanOrEqual(100 * 100 * 0.9);
  expect(changed.changed_pixels).toBeLessThan(100 * 100 * 1.5);
  expect(changed.changed_share).toBeGreaterThan(0);

  const image = reply.content?.find((item) => item.type === 'file');

  if (image?.type !== 'file') throw new Error('No diff image');

  expect(image.mime).toBe('image/png');

  const decoded = await page.evaluate(async (uri) => {
    const bitmap = await createImageBitmap(await (await fetch(uri)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const draw = canvas.getContext('2d');

    draw?.drawImage(bitmap, 0, 0);

    const at = (x: number, y: number) => [...(draw?.getImageData(x, y, 1, 1).data ?? [])];

    return {
      width: bitmap.width,
      height: bitmap.height,
      inside: at(90, 90),
      outside: at(300, 300),
    };
  }, image.uri);

  expect(decoded).toMatchObject({ width: changed.width, height: changed.height });
  expect(decoded.inside).toEqual([255, 0, 0, 255]);

  const [r = 0, g = 0, b = 0] = decoded.outside;

  expect(r === g && g === b).toBe(true);

  expect(await run.fail('screenshot_diff', { baseline: 'missing' })).toMatchObject({
    code: 'no_baseline',
  });
});

test('record_start, a navigation and record_stop download an MP4 with the frames (sidekick-19)', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/color.html`);

  const run = await sidekick.start(page);

  expect(await run.call('record_start', { frame_rate: 10 })).toMatchObject({ recording: true });
  expect(await run.fail('record_start')).toMatchObject({ code: 'recording_running' });

  await page.waitForTimeout(500);
  await run.call('navigate', { url: `${origin()}/tabs.html` });
  await page.waitForTimeout(500);

  expect(await run.call('record_status')).toMatchObject({ recording: true });

  const report = await run.call<RecordingReport>('record_stop');

  expect(report).toMatchObject({ codec: 'avc', frames_dropped: 0 });
  expect(report.frames_written).toBeGreaterThanOrEqual(2);

  const download = await newestDownload(context);

  expect(download).toMatchObject({ mime: 'video/mp4', bytes: report.bytes });
  expect(report.file).toBe(path.basename(download.path));
  expect(download.file.length).toBe(report.bytes);

  const video = await videoOf(download.file);

  expect(video).toMatchObject({ codec: 'avc', width: report.width, height: report.height });
  expect(video.frames).toBeGreaterThanOrEqual(2);
  expect(video.duration).toBeGreaterThan(0.5);
});

test('closing the recorded tab ends the recording with the tab_closed reason and keeps the video (sidekick-19)', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/color.html`);

  const run = await sidekick.start(page);

  await run.call('tabs_open', { url: `${origin()}/tabs.html` });
  await run.call('record_start');
  await page.waitForTimeout(500);
  await page.close();

  let status: Partial<RecordingReport> & { recording?: boolean; ended?: string } = {};

  await expect
    .poll(async () => {
      status = await run.call('record_status');

      return status.ended;
    })
    .toBe('tab_closed');

  expect(status).toMatchObject({ recording: false, codec: 'avc' });

  const download = await newestDownload(context);

  expect(download).toMatchObject({ mime: 'video/mp4', bytes: status.bytes });

  const video = await videoOf(download.file);

  expect(video.frames).toBeGreaterThanOrEqual(1);
});
