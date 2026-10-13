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
