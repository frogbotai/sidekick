import { expect, refFor, type SnapshotOutput, test } from './fixtures';

declare global {
  interface Window {
    keys: string[];
  }
}

test('type sends a key event per character, where fill sends none', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/keys.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });
  const search = refFor(snapshot, 'Search');
  const notes = refFor(snapshot, 'Notes');

  expect(await run.call('type', { ref: search, text: 'abc' })).toMatchObject({ typed: 3 });
  expect(await page.evaluate(() => window.keys)).toEqual(['search:a', 'search:b', 'search:c']);
  await expect(page.locator('#search')).toHaveValue('abc');

  await run.call('type', { ref: notes, text: 'there' });
  await expect(page.locator('#notes')).toHaveValue('Hi there');

  await page.evaluate(() => (window.keys = []));
  await run.call('fill', { ref: search, text: 'xyz' });
  await expect(page.locator('#search')).toHaveValue('xyz');
  expect(await page.evaluate(() => window.keys)).toEqual([]);
});

test('wait_for returns when late text appears, sees a removed element as hidden, and times out on text that never comes', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/late.html`);

  const run = await sidekick.start(page);
  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });
  const spinner = refFor(snapshot, 'Cancel loading');

  const shown = await run.call<{ waited_ms: number }>('wait_for', { text: 'Results are ready' });

  expect(shown.waited_ms).toBeGreaterThan(500);
  expect(await run.call('wait_for', { ref: spinner, state: 'hidden' })).toMatchObject({});

  const error = await run.fail('wait_for', { text: 'Never shown', timeout_ms: 1_000 });

  expect(error).toMatchObject({ code: 'timeout' });
  expect(error.message).toContain('“Never shown”');
});

test('eval returns JSON from the page and the message of a thrown error', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/keys.html`);

  const run = await sidekick.start(page);

  expect(await run.call('eval', { script: 'document.title' })).toEqual({
    value: '"Keys"',
    truncated: false,
  });

  expect(
    await run.call('eval', { script: 'await new Promise((r) => setTimeout(() => r([1, 2]), 50))' }),
  ).toEqual({ value: '[1,2]', truncated: false });

  const { snapshot } = await run.call<SnapshotOutput>('snapshot', { scope: 'page' });

  expect(
    await run.call('eval', { ref: refFor(snapshot, 'Notes'), script: '(el) => el.value' }),
  ).toEqual({ value: '"Hi "', truncated: false });

  expect(await page.locator('[data-sidekick-eval]').count()).toBe(0);

  const thrown = await run.fail('eval', { script: "throw new Error('boom')" });

  expect(thrown).toMatchObject({ code: 'script_error' });
  expect(thrown.message).toContain('boom');

  page.on('dialog', () => undefined);

  const dialog = await run.fail('eval', { script: "alert('Hello there')" });

  expect(dialog).toMatchObject({ code: 'script_error' });
  expect(dialog.message).toContain('Hello there');
  expect(await run.call('eval', { script: '1 + 1' })).toEqual({ value: '2', truncated: false });
});

test('eval refuses a DOM node, a function or a Map instead of returning {}', async ({
  context,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/keys.html`);

  const run = await sidekick.start(page);

  for (const script of [
    'document.body',
    '() => 1',
    'new Map([[1, 2]])',
    '({ a: [window] })',
    'Symbol("x")',
  ]) {
    expect(await run.fail('eval', { script })).toMatchObject({ code: 'script_error' });
  }

  expect(
    await run.call('eval', { script: '({ when: new Date(0), list: [1, "a", null] })' }),
  ).toEqual({ value: '{"when":"1970-01-01T00:00:00.000Z","list":[1,"a",null]}', truncated: false });
});

test('eval that takes 25 s returns its value and runs once, past the idle detach', async ({
  context,
  origin,
  sidekick,
}) => {
  test.setTimeout(60_000);

  const page = await context.newPage();

  await page.goto(`${origin()}/keys.html`);

  const run = await sidekick.start(page);

  expect(
    await run.call('eval', {
      script:
        'window.runs = (window.runs ?? 0) + 1; await new Promise((r) => setTimeout(r, 25000)); "done"',
    }),
  ).toEqual({ value: '"done"', truncated: false });

  expect(await page.evaluate(() => Reflect.get(window, 'runs'))).toBe(1);
});

test('eval of an endless loop fails timeout after 30 s, and the page works again', async ({
  context,
  origin,
  sidekick,
}) => {
  test.setTimeout(60_000);

  const page = await context.newPage();

  await page.goto(`${origin()}/keys.html`);

  const run = await sidekick.start(page);

  expect(await run.fail('eval', { script: 'while (true) {}' })).toMatchObject({ code: 'timeout' });
  expect(await run.call('eval', { script: '1 + 1' })).toEqual({ value: '2', truncated: false });
});
