import type { BrowserContext, Page } from '@playwright/test';

import {
  callTool,
  callTools,
  expect,
  INDICATOR,
  isolatedWorld,
  reply,
  scriptOpenAI,
  test,
} from './fixtures';

const MODEL = 'openai/gpt-6-luna';

const CARD = `(() => {
  const card = [...document.querySelectorAll('*')]
    .map((element) => chrome.dom.openOrClosedShadowRoot(element))
    .find((root) => root?.querySelector('.handoff'))
    ?.querySelector('.handoff');

  if (!card) return null;

  const button = card.querySelector('button').getBoundingClientRect();

  return {
    open: card.matches(':popover-open'),
    text: card.textContent,
    x: button.x + button.width / 2,
    y: button.y + button.height / 2,
  };
})()`;

interface Card {
  open: boolean;
  text: string;
  x: number;
  y: number;
}

function tabOf(body: string | undefined) {
  const found = /tab_id\\*"\s*:\s*(\d+)/.exec(body ?? '')?.[1];

  if (!found) throw new Error(`No tab_id in ${body}`);

  return Number(found);
}

async function connect(panel: Page) {
  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();

  await panel.evaluate(async (model) => {
    await window.sidekick.provider.credentials.add({
      providerID: 'openai',
      label: 'e2e',
      value: { type: 'key', key: 'sk-good' },
    });

    await chrome.storage.local.set({ model });
  }, MODEL);

  await expect(panel.getByRole('textbox')).toBeVisible();
}

async function badge(context: BrowserContext, tabId: number) {
  const sw = context.serviceWorkers()[0];

  return sw?.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
}

async function pageOf(context: BrowserContext, path: string) {
  await expect.poll(() => context.pages().some((page) => page.url().endsWith(path))).toBe(true);

  const found = context.pages().find((page) => page.url().endsWith(path));

  if (!found) throw new Error(`No page ${path}`);

  return found;
}

test('the panel agent hands the tab over: card and WAIT until a trusted Continue, no read before it, then from the panel', async ({
  context,
  extensionId,
  openPanel,
  origin,
  sidekick,
}) => {
  const url = `${origin()}/color.html`;

  const { bodies } = await scriptOpenAI(context, [
    callTool('tabs_open', { url }, 'call_open'),
    () => {
      const tab_id = tabOf(bodies.at(-1));

      return Promise.resolve(
        callTools([
          {
            name: 'handoff',
            input: { tab_id, message: 'Sign in to the test site' },
            callID: 'call_hand',
          },
          { name: 'snapshot', input: { tab_id }, callID: 'call_snap' },
        ]),
      );
    },
    () =>
      Promise.resolve(
        callTool(
          'handoff',
          { tab_id: tabOf(bodies.at(-1)), message: 'Confirm the payment' },
          'call_pay',
        ),
      ),
    reply('Signed in and paid.'),
  ]);

  const panel = await openPanel();

  await connect(panel);
  await panel.getByRole('textbox').fill('Sign in for me');
  await panel.getByRole('textbox').press('Enter');

  const page = await pageOf(context, '/color.html');
  const evaluate = await isolatedWorld(context, page, extensionId);
  const tabId = await sidekick.tabId(page);
  const dock = panel.getByRole('region', { name: 'Sidekick is waiting for you' });

  await expect
    .poll(() => evaluate(CARD), { timeout: 20_000 })
    .toMatchObject({ open: true, text: expect.stringContaining('Sign in to the test site') });

  await expect.poll(() => badge(context, tabId)).toBe('WAIT');
  await expect(dock).toContainText('Sign in to the test site');

  await page.screenshot({ path: test.info().outputPath('handoff-page.png') });
  await dock.screenshot({ path: test.info().outputPath('handoff-panel.png') });

  await page.evaluate(() => {
    document.title = 'Signed in';
    document.body.innerHTML = '<p>Welcome back</p>';
  });

  await evaluate(`${INDICATOR}.querySelector('.handoff button').click()`);

  expect(bodies).toHaveLength(2);
  expect(await evaluate(CARD)).toMatchObject({ open: true });

  const card = (await evaluate(CARD)) as Card;

  await page.bringToFront();
  await page.mouse.click(card.x, card.y);

  await expect.poll(() => bodies.length, { timeout: 20_000 }).toBe(3);
  expect(bodies[2]).toMatch(/status\\*"\s*:\s*\\*"resolved/);
  expect(bodies[2]).toContain('Welcome back');

  await expect
    .poll(() => evaluate(CARD))
    .toMatchObject({ open: true, text: expect.stringContaining('Confirm the payment') });

  await expect(dock).toContainText('Confirm the payment');

  await dock.getByRole('button', { name: 'Continue' }).click();

  await expect(panel.getByText('Signed in and paid.')).toBeVisible({ timeout: 20_000 });
  expect(bodies.at(-1)).toMatch(/status\\*"\s*:\s*\\*"resolved/);
  await expect.poll(async () => ((await evaluate(CARD)) as Card | null)?.open ?? false).toBe(false);
  await expect.poll(() => badge(context, tabId)).toBe('');
  await expect(dock).toHaveCount(0);
});

test('Continue works over a modal dialog the page opens, which makes the rest of the page inert', async ({
  context,
  extensionId,
  origin,
  sidekick,
}) => {
  const page = await context.newPage();

  await page.goto(`${origin()}/labelled.html`);

  const evaluate = await isolatedWorld(context, page, extensionId);
  const run = await sidekick.start(page);
  const reply = run.reply('handoff', { message: 'Sign in in the dialog, then Continue' });

  await expect.poll(() => evaluate(CARD), { timeout: 20_000 }).toMatchObject({ open: true });

  await page.evaluate(() => {
    const dialog = document.createElement('dialog');

    dialog.textContent = 'Sign in';
    document.body.append(dialog);
    dialog.showModal();
  });

  await expect.poll(() => evaluate(CARD)).toMatchObject({ open: true });

  const card = (await evaluate(CARD)) as Card;

  await page.bringToFront();
  await page.mouse.click(card.x, card.y);

  expect(await reply).toMatchObject({ ok: { status: 'resolved' } });
  expect(await page.evaluate(() => document.querySelector('dialog')?.open)).toBe(true);
});
