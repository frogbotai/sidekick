import { expect, test } from './fixtures';

const STATE = `JSON.stringify({ width: innerWidth, dark: matchMedia('(prefers-color-scheme: dark)').matches })`;

test.use({ screenScale: 1 });

test('emulate sets a phone viewport and dark mode, keeps them through a debugger detach, and clears them when the run ends', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/media.html`);

  const before = await page.evaluate(() => innerWidth);
  const run = await sidekick.start(page);

  expect(
    await run.call('emulate', {
      viewport: { width: 390, height: 844, device_scale_factor: 3, mobile: true },
      color_scheme: 'dark',
    }),
  ).toMatchObject({ active: { viewport: { width: 390 }, color_scheme: 'dark' } });

  expect(await run.call('eval', { script: STATE })).toEqual({
    value: JSON.stringify(JSON.stringify({ width: 390, dark: true })),
    truncated: false,
  });

  await sidekick.send({ sidekickTest: 'detach', tabId: run.tabId });

  expect(await run.call('eval', { script: STATE })).toEqual({
    value: JSON.stringify(JSON.stringify({ width: 390, dark: true })),
    truncated: false,
  });

  await sidekick.send({ sidekickTest: 'stop', runId: run.runId });

  await expect
    .poll(() =>
      page.evaluate(() => ({
        width: innerWidth,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      })),
    )
    .toEqual({ width: before, dark: false });
});

test('emulate with nothing to set fails and lists the overrides', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/media.html`);

  const run = await sidekick.start(page);
  const error = await run.fail('emulate', {});

  expect(error).toMatchObject({ code: 'invalid_target' });
  expect(error.message).toContain('viewport');
});
