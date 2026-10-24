import {
  type ActionOutput,
  expect,
  INDICATOR,
  isolatedWorld,
  refFor,
  type SnapshotOutput,
  test,
} from './fixtures';

const STOP_BUTTON = `${INDICATOR}?.querySelector('.stop')`;

test.describe('another extension’s frame (271 D1)', () => {
  test.use({ blocker: true });

  test('strips the frame and clicks, unless the kill switch is off', async ({
    context,
    origin,
    sidekick,
  }) => {
    const page = await context.newPage();

    await page.goto(`${origin()}/blocked.html`);
    await expect(page.locator('iframe[title="Blocker frame"]')).toHaveCount(1);

    const run = await sidekick.start(page);
    const { snapshot } = await run.call<SnapshotOutput>('snapshot');
    const button = refFor(snapshot, 'Blocked button');
    const worker = context.serviceWorkers()[0];

    await worker?.evaluate(() => chrome.storage.local.set({ stripExtensionFrames: false }));

    expect(await run.fail('click', { ref: button })).toMatchObject({
      code: 'attach_blocked',
      detail: { reason: 'other_extension' },
    });

    expect(await page.evaluate(() => window.log)).toEqual([]);
    await expect(page.locator('iframe[title="Blocker frame"]')).toHaveCount(1);

    await worker?.evaluate(() => chrome.storage.local.set({ stripExtensionFrames: true }));
    await run.call('click', { ref: button });

    expect(await page.evaluate(() => window.log)).toEqual(['blocked-click:true']);
    await expect(page.locator('iframe[title="Blocker frame"]')).toHaveCount(0);
  });
});

test('refuses tabs outside the group, and adopts a tab a group tab opens', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/tabs.html`);

  const run = await sidekick.start(page);
  const outside = await context.newPage();

  await outside.goto(`${origin()}/color.html?outside`);

  expect(await run.fail('snapshot', { tab_id: await sidekick.tabId(outside) })).toMatchObject({
    code: 'not_in_group',
  });

  const { snapshot } = await run.call<SnapshotOutput>('snapshot');
  const opened = context.waitForEvent('page');

  await run.call('click', { ref: refFor(snapshot, 'Open in a new tab') });

  const blank = await opened;

  await blank.waitForURL(/from=blank/);

  const blankId = await sidekick.tabId(blank);

  await expect
    .poll(async () => {
      const { tabs } = await run.call<{ tabs: { tab_id: number }[] }>('tabs_list');

      return tabs.map(({ tab_id }) => tab_id).sort();
    })
    .toEqual([run.tabId, blankId].sort());

  const inBlank = await run.call<SnapshotOutput>('snapshot', { tab_id: blankId });

  expect(inBlank.snapshot).toContain('Press me');
});

test('tabs_open settles on a page with a cross-origin frame', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/live-site.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot');

  await run.call('click', { ref: refFor(snapshot, 'Search') });

  const opened = await run.call<{ settled: boolean }>('tabs_open', {
    url: `${origin()}/frames.html`,
    focus: true,
  });

  expect(opened.settled).toBe(true);
});

test('tabs_open waits for frames a page adds after load, and navigate goes back and forward', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/live-site.html`);

  const run = await sidekick.start(page);
  const mdn = `${origin()}/mdn.html`;
  const opened = await run.call<{ tab_id: number; settled: boolean }>('tabs_open', { url: mdn });
  const tab = { tab_id: opened.tab_id };

  const groupOf = (id: number) =>
    context
      .serviceWorkers()[0]
      ?.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).groupId, id);

  expect(await groupOf(opened.tab_id)).toBe(run.groupId);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { ...tab, scope: 'page' });

  expect(refFor(snapshot, 'Name, 4 to 8 characters')).toMatch(/^f[1-9]\d*e\d+$/);

  const there = await run.call<ActionOutput>('navigate', {
    ...tab,
    url: `${origin()}/color.html`,
  });

  expect(there.url).toBe(`${origin()}/color.html`);

  const back = await run.call<ActionOutput>('navigate', { ...tab, go: 'back' });

  expect(back.url).toBe(mdn);

  const forward = await run.call<ActionOutput>('navigate', { ...tab, go: 'forward' });

  expect(forward.url).toBe(`${origin()}/color.html`);
  expect(await groupOf(opened.tab_id)).toBe(run.groupId);

  expect(await run.fail('navigate', { ...tab, go: 'forward' })).toMatchObject({
    code: 'invalid_target',
  });
});

test('the indicator ignores a synthetic Stop and honours a trusted one', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/color.html`);

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);

  await expect.poll(() => evaluate(`Boolean(${STOP_BUTTON})`)).toBe(true);

  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });

  expect(snapshot).not.toContain('Stop Sidekick');

  await evaluate(`${STOP_BUTTON}.click()`);

  await page.evaluate(() => {
    for (const element of document.documentElement.children) {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    }
  });

  expect(await sidekick.runs()).toContainEqual({ runId: run.runId, groupId: run.groupId });

  const box = (await evaluate(`(() => {
    const { x, y, width, height } = ${STOP_BUTTON}.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  })()`)) as { x: number; y: number };

  await page.mouse.click(box.x, box.y);

  await expect.poll(() => sidekick.runs()).toEqual([]);
  await expect.poll(() => evaluate(`Boolean(${STOP_BUTTON})`)).toBe(false);
  expect(await run.fail('snapshot')).toMatchObject({ code: 'stopped' });
});

test('x/y on the Stop button fail invalid_target and send nothing; a point beside it works (333 req. 3)', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/color.html`);

  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);

  await expect.poll(() => evaluate(`Boolean(${STOP_BUTTON})`)).toBe(true);
  await run.call('screenshot');

  let height = 0;

  await expect
    .poll(
      async () => {
        const previous = height;

        height = await page.evaluate(() => innerHeight);

        return height === previous;
      },
      { message: 'the debugging bar has finished shrinking the viewport', intervals: [250] },
    )
    .toBe(true);

  await run.call('screenshot');

  const stop = (await evaluate(
    `${STOP_BUTTON}.getBoundingClientRect().toJSON()`,
  )) as DOMRectReadOnly;

  const centre = {
    x: Math.round(stop.x + stop.width / 2),
    y: Math.round(stop.y + stop.height / 2),
  };

  await page.evaluate(() => {
    for (const type of ['pointerdown', 'pointermove']) {
      addEventListener(type, () => window.log.push(type), true);
    }
  });

  for (const [tool, input] of [
    ['click', centre],
    ['hover', centre],
    ['drag', { from: centre, to: { x: 10, y: 10 } }],
    ['drag', { from: { x: 10, y: 10 }, to: centre }],
  ] as const) {
    expect({ tool, input, error: await run.fail(tool, input) }).toMatchObject({
      tool,
      input,
      error: {
        code: 'invalid_target',
        message: 'That point is Sidekick’s Stop button, not the page. Pick a point on the page.',
      },
    });
  }

  expect(await sidekick.runs()).toContainEqual({ runId: run.runId, groupId: run.groupId });
  expect(await page.evaluate(() => window.log)).toEqual([]);

  await run.call<ActionOutput>('click', { x: centre.x, y: Math.floor(stop.top) - 1 });

  expect(await page.evaluate(() => window.log)).toContain('pointerdown');
  expect(await sidekick.runs()).toContainEqual({ runId: run.runId, groupId: run.groupId });
});
