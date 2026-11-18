import { expect, test } from './fixtures';

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
