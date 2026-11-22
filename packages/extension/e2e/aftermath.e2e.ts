import { type ActionOutput, expect, refFor, type SnapshotOutput, test } from './fixtures';

test('reports a popup, a # change and dialogs from a click or a focus, and answers them', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  page.on('dialog', () => undefined);
  await page.goto(`${origin()}/aftermath.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot');

  const opened = await run.call<ActionOutput>('click', { ref: refFor(snapshot, 'Open receipt') });

  expect(opened).toMatchObject({
    navigated: false,
    newTabs: [{ tab_id: expect.any(Number), url: `${origin()}/receipt.html` }],
    dialog: null,
  });

  await page.bringToFront();

  const jumped = await run.call<ActionOutput>('click', {
    ref: refFor(snapshot, 'Jump to details'),
  });

  expect(jumped).toMatchObject({
    url: `${origin()}/aftermath.html#details`,
    navigated: false,
    urlChanged: true,
    newTabs: [],
  });

  const started = Date.now();
  const asked = await run.call<ActionOutput>('click', { ref: refFor(snapshot, 'Delete order') });

  expect(Date.now() - started).toBeLessThan(5_000);

  expect(asked).toMatchObject({
    settled: false,
    dialog: { type: 'confirm', message: 'Delete this order?', defaultValue: '' },
  });

  expect(await run.fail('snapshot')).toMatchObject({ code: 'dialog_open' });
  expect(await run.call('dialog', { action: 'accept' })).toMatchObject({ dialog: null });

  const renaming = await run.call<ActionOutput>('click', { ref: refFor(snapshot, 'Rename order') });

  expect(renaming.dialog).toEqual({
    type: 'prompt',
    message: 'New name?',
    defaultValue: 'Order 1',
  });

  await run.call('dialog', { action: 'accept', promptText: 'Order 2' });

  expect(await page.evaluate(() => window.answers)).toEqual([true, 'Order 2']);

  const pressing = Date.now();
  const focused = await run.call<ActionOutput>('press', {
    ref: refFor(snapshot, 'Coupon'),
    key: 'a',
  });

  expect(Date.now() - pressing).toBeLessThan(5_000);
  expect(focused.dialog).toMatchObject({ type: 'alert', message: 'Coupons are paused' });

  await run.call('dialog', { action: 'dismiss' });

  expect(await run.call('dialog', { action: 'get' })).toMatchObject({ dialog: null });
});

test('a dialog left open past the idle detach can still be answered, and select re-attaches', async ({
  context,
  origin,
  sidekick,
}) => {
  test.setTimeout(120_000);

  const page = await context.newPage();

  page.on('dialog', () => undefined);
  await page.goto(`${origin()}/aftermath.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot');
  const asked = await run.call<ActionOutput>('click', { ref: refFor(snapshot, 'Delete order') });

  expect(asked.dialog).toMatchObject({ type: 'confirm' });

  await page.waitForTimeout(23_000);

  const answering = Date.now();

  expect(await run.call('dialog', { action: 'accept' })).toMatchObject({ dialog: null });
  expect(Date.now() - answering).toBeLessThan(5_000);
  expect(await page.evaluate(() => window.answers)).toEqual([true]);

  await page.waitForTimeout(23_000);

  const selecting = Date.now();
  const selected = await run.call<ActionOutput>('select', {
    ref: refFor(snapshot, 'Plan'),
    values: ['pro'],
  });

  expect(Date.now() - selecting).toBeLessThan(5_000);
  expect(selected.dialog).toMatchObject({ type: 'alert', message: 'Plan changed' });

  await run.call('dialog', { action: 'accept' });
});
