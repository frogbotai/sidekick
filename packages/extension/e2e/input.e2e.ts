import { expect, refFor, type SnapshotOutput, test } from './fixtures';

const EDITORS = [
  ['lexical', 'Lexical editor'],
  ['prosemirror', 'ProseMirror editor'],
  ['draft', 'Draft editor'],
] as const;

test('fills real Lexical, ProseMirror and Draft.js editors, replacing their text', async ({
  context,
  origin,
  sidekick,
}, testInfo) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/editors.html`);
  await expect.poll(() => page.evaluate(() => typeof window.editorText)).toBe('object');

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });

  for (const [id, label] of EDITORS) {
    const text = `Hello ${id} from Sidekick`;

    await run.call('fill', { ref: refFor(snapshot, label), text });
    await expect.poll(() => page.evaluate((editor) => window.editorText[editor](), id)).toBe(text);
  }

  const events = await page.evaluate(() => window.beforeInputs);

  await testInfo.attach('beforeinput', {
    body: JSON.stringify(events, null, 2),
    contentType: 'application/json',
  });

  expect(events.filter(({ editor }) => editor === 'lexical')).toContainEqual(
    expect.objectContaining({ inputType: 'insertText', data: 'Hello lexical from Sidekick' }),
  );
});

test('scroll_to lands below a sticky header that grows late', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/sticky.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });
  const target = refFor(snapshot, 'Far target');

  expect(await run.call('scroll_to', { ref: target })).toEqual({ in_view: true });

  const box = await page.evaluate(() => window.targetBox());

  expect(box.top).toBeGreaterThanOrEqual(box.header);
  expect(box.bottom).toBeLessThanOrEqual(box.viewport);

  await run.call('click', { ref: target });

  expect(await page.evaluate(() => window.log)).toEqual(['target-click:true']);
});

test('scrolls the container under a ref, and reports the end', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/nested.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });
  const inner = refFor(snapshot, 'Inner button');

  const first = await run.call<{ moved: number; container: string; at_end: boolean }>('scroll', {
    ref: inner,
    direction: 'down',
    amount: 100,
  });

  expect(first).toMatchObject({ moved: 100, at_end: false });
  expect(first.container).toContain('inner');
  expect(await page.evaluate(() => window.scrolls())).toEqual({ page: 0, outer: 0, inner: 100 });

  const rest = await run.call<{ moved: number; at_end: boolean }>('scroll', {
    ref: inner,
    direction: 'down',
    amount: 5_000,
  });

  expect(rest.at_end).toBe(true);
  expect(rest.moved).toBeGreaterThan(0);

  const outer = await run.call<{ container: string }>('scroll', {
    ref: refFor(snapshot, 'Outer button'),
    direction: 'down',
    amount: 50,
  });

  expect(outer.container).toContain('outer');
  expect(await page.evaluate(() => window.scrolls())).toMatchObject({ page: 0, outer: 50 });

  const document = await run.call<{ moved: number }>('scroll', { direction: 'down', amount: 200 });

  expect(document.moved).toBe(200);
  expect(await page.evaluate(() => window.scrolls().page)).toBe(200);
});

test('fill gives ok when the page swaps the field while typing, and the new field holds the text', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/recycle.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot');

  expect(await run.call('fill', { ref: refFor(snapshot, 'Domain'), text: 'frogbot.co' })).toEqual(
    expect.objectContaining({ navigated: false }),
  );

  expect(await page.evaluate(() => window.swaps)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.domainValue())).toBe('frogbot.co');
});

test('fill without a ref types into the field focused in a cross-origin frame, and fails with nothing editable focused', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/frames.html`);

  const field = page.frameLocator('#cross').getByLabel('Frame field');

  await expect(field).toBeVisible();

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });

  expect(await run.fail('fill', { text: 'nowhere' })).toMatchObject({ code: 'not_editable' });

  await run.call('click', { ref: refFor(snapshot, 'Frame field') });
  await run.call('fill', { text: 'typed at focus' });

  await expect(field).toHaveValue('typed at focus');

  await run.call('click', { ref: refFor(snapshot, 'Top button') });

  expect(await run.fail('fill', { text: 'nowhere' })).toMatchObject({
    code: 'not_editable',
    message: 'Nothing editable has focus. Click the field first, or fill by ref.',
  });
});

test('check sets native, ARIA and switch controls, safe to repeat, and says when the page undoes it', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/checks.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot');
  const ref = (label: string) => refFor(snapshot, label);

  for (const label of ['Auto-renew', 'Privacy protection', 'Domain lock']) {
    expect(await run.call('check', { ref: ref(label), checked: true })).toMatchObject({
      checked: true,
      changed: true,
    });

    expect(await run.call('check', { ref: ref(label), checked: true })).toMatchObject({
      checked: true,
      changed: false,
    });
  }

  expect(await page.evaluate(() => window.checks())).toMatchObject({
    native: true,
    aria: true,
    switch: true,
  });

  expect(await run.fail('check', { ref: ref('Transfer lock'), checked: true })).toMatchObject({
    code: 'input_mismatch',
    message: expect.stringContaining('don’t toggle it again'),
  });

  expect(await run.fail('check', { ref: ref('Email alerts'), checked: true })).toMatchObject({
    code: 'stale_ref',
    message: expect.stringContaining('was replaced after the click'),
  });

  const fresh = await run.call<SnapshotOutput>('snapshot');

  expect(
    await run.call('check', { ref: refFor(fresh.snapshot, 'Email alerts'), checked: true }),
  ).toMatchObject({ changed: false });

  expect(await run.fail('check', { ref: ref('Monthly'), checked: false })).toMatchObject({
    code: 'invalid_target',
  });

  await run.call('check', { ref: ref('Yearly'), checked: true });

  expect(await page.evaluate(() => window.checks())).toMatchObject({
    resetting: false,
    rerender: true,
    billing: 'yearly',
  });
});

test('a short snapshot reaches a dialog added at the end of the page, and fill by its refs works', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/dialog.html`);

  const run = await sidekick.start(page);
  const first = await run.call<SnapshotOutput>('snapshot');

  await run.call('click', { ref: refFor(first.snapshot, 'Edit nameservers') });

  const { snapshot, truncated } = await run.call<SnapshotOutput>('snapshot', {
    max_chars: 2_000,
  });

  expect(truncated).toBe(true);
  expect(snapshot.startsWith('- dialog "Edit nameservers"')).toBe(true);

  await run.call('fill', {
    ref: refFor(snapshot, 'Nameserver 1'),
    text: 'keyla.ns.cloudflare.com',
  });

  await run.call('fill', {
    ref: refFor(snapshot, 'Nameserver 2'),
    text: 'lochlan.ns.cloudflare.com',
  });

  expect(await page.evaluate(() => window.nameservers())).toEqual([
    'keyla.ns.cloudflare.com',
    'lochlan.ns.cloudflare.com',
  ]);
});
