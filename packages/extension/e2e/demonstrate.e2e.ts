import type { Page } from '@playwright/test';

import { expect, isolatedWorld, type SnapshotOutput, test } from './fixtures';

const CARD = `(() => {
  const card = [...document.querySelectorAll('*')]
    .map((element) => chrome.dom.openOrClosedShadowRoot(element))
    .find((root) => root?.querySelector('.handoff'))
    ?.querySelector('.handoff');

  if (!card) return null;

  const button = card.querySelector('button').getBoundingClientRect();
  const recording = card.querySelector('.handoff__recording');

  return {
    open: card.matches(':popover-open'),
    recording: Boolean(recording && !recording.hidden && recording.checkVisibility()),
    text: card.textContent,
    x: button.x + button.width / 2,
    y: button.y + button.height / 2,
  };
})()`;

interface Card {
  open: boolean;
  recording: boolean;
  text: string;
  x: number;
  y: number;
}

interface Step {
  kind: string;
  role?: string;
  name?: string;
  value?: string;
  masked?: string;
  redacted?: boolean;
  checked?: boolean;
  url?: string;
}

interface Demonstration {
  status: string;
  started_url: string;
  ended_url: string;
  steps: Step[];
  summary: string;
}

function refByRole(snapshot: string, role: string, name: string) {
  const matches = [
    ...snapshot.matchAll(new RegExp(`- ${role} "${name}"[^\\n]*\\[(f\\d+e\\d+)\\]`, 'g')),
  ];

  if (matches.length !== 1) {
    throw new Error(`${matches.length} matches for ${role} "${name}" in:\n${snapshot}`);
  }

  return matches[0]?.[1];
}

async function pressContinue(page: Page, evaluate: (expression: string) => Promise<unknown>) {
  await expect.poll(() => evaluate(CARD), { timeout: 20_000 }).toMatchObject({ open: true });

  const card = (await evaluate(CARD)) as Card;

  await page.bringToFront();
  await page.mouse.click(card.x, card.y);
}

test('the person demonstrates a flow while the card says it records, and the agent gets the steps and a summary (sidekick-21)', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/demonstrate.html`);

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);
  const reply = run.reply('demonstrate', { message: 'Show me how you order' });

  await expect
    .poll(() => evaluate(CARD), { timeout: 20_000 })
    .toMatchObject({
      open: true,
      recording: true,
      text: expect.stringContaining('Sidekick is recording your clicks and typing'),
    });

  await page.screenshot({ path: test.info().outputPath('demonstrate-card.png') });

  await page.getByRole('searchbox', { name: 'Search' }).fill('red shoes');
  await page.getByRole('textbox', { name: 'Address' }).fill('1 Main St');
  await page.getByLabel('Password').fill('hunter2');
  await page.getByRole('checkbox', { name: 'Gift wrap' }).check();
  await page.getByRole('button', { name: 'Find' }).click();
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.waitForURL(/\?done$/);

  const after = await isolatedWorld(context, page, extensionId);

  await expect.poll(() => after(CARD), { timeout: 20_000 }).toMatchObject({ recording: true });
  await pressContinue(page, after);

  const result = await reply;

  if ('error' in result) throw new Error(result.error.message);

  const output = result.ok as Demonstration;

  expect(output).toMatchObject({
    status: 'resolved',
    started_url: `${origin()}/demonstrate.html`,
    ended_url: `${origin()}/demonstrate.html`,
  });

  expect(output.steps).toEqual([
    expect.objectContaining({
      kind: 'fill',
      role: 'searchbox',
      name: 'Search',
      value: 'red shoes',
    }),
    expect.objectContaining({ kind: 'fill', name: 'Address', masked: 'street-address' }),
    expect.objectContaining({ kind: 'fill', name: 'Password', redacted: true }),
    expect.objectContaining({ kind: 'check', role: 'checkbox', name: 'Gift wrap', checked: true }),
    expect.objectContaining({ kind: 'click', role: 'button', name: 'Find' }),
    expect.objectContaining({ kind: 'click', role: 'link', name: 'Checkout' }),
    { kind: 'navigation', url: `${origin()}/demonstrate.html` },
  ]);

  expect(JSON.stringify(output)).not.toContain('1 Main St');
  expect(JSON.stringify(output)).not.toContain('hunter2');
  expect(output.summary).toContain('1. Typed "red shoes" into "Search"');
  expect(output.summary).toContain('Typed your street address into "Address"');

  await expect.poll(async () => ((await after(CARD)) as Card | null)?.open ?? false).toBe(false);
});

test('the agent replays a demonstration on a re-rendered page by snapshot, role and name (sidekick-21 req. 8)', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/demonstrate.html`);

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);
  const reply = run.reply('demonstrate', { message: 'Show me how you search' });

  await expect.poll(() => evaluate(CARD), { timeout: 20_000 }).toMatchObject({ recording: true });

  await page.getByRole('searchbox', { name: 'Search' }).fill('red shoes');
  await page.getByRole('checkbox', { name: 'Gift wrap' }).check();
  await page.getByRole('button', { name: 'Find' }).click();
  await pressContinue(page, evaluate);

  const result = await reply;

  if ('error' in result) throw new Error(result.error.message);

  const { steps } = result.ok as Demonstration;

  await run.call('navigate', { url: `${origin()}/demonstrate.html?again` });

  const { snapshot } = await run.call<SnapshotOutput>('snapshot', {});

  for (const step of steps) {
    const ref = refByRole(snapshot, step.role ?? '', step.name ?? '');

    if (step.kind === 'fill') await run.call('fill', { ref, text: step.value });
    else if (step.kind === 'check') await run.call('check', { ref, checked: step.checked });
    else if (step.kind === 'click') await run.call('click', { ref });
  }

  expect(await page.locator('#x-q-2').inputValue()).toBe('red shoes');
  expect(await page.locator('#x-gift-2').isChecked()).toBe(true);
  expect(await page.evaluate(() => window.log)).toEqual(['find']);
});

test('a GET form keeps the typed password and address out of the result (sidekick-21 req. 5, D3 B)', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/demonstrate.html`);

  await page.evaluate(() => {
    document.querySelector('[autocomplete="street-address"]')?.setAttribute('name', 'addr');
    document.querySelector('[type="password"]')?.setAttribute('name', 'pw');

    document
      .querySelector('form')
      ?.insertAdjacentHTML('beforeend', '<button type="submit">Sign in</button>');
  });

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);
  const reply = run.reply('demonstrate', { message: 'Show me how you sign in' });

  await expect.poll(() => evaluate(CARD), { timeout: 20_000 }).toMatchObject({ recording: true });

  await page.getByRole('textbox', { name: 'Address' }).fill('1 Main St');
  await page.getByLabel('Password').fill('hunter2');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/pw=hunter2/);

  await pressContinue(page, await isolatedWorld(context, page, extensionId));

  const result = await reply;

  if ('error' in result) throw new Error(result.error.message);

  const output = result.ok as Demonstration;

  expect(JSON.stringify(output)).not.toMatch(/hunter2|Main/);
  expect(output.ended_url).toBe(`${origin()}/demonstrate.html`);
});
