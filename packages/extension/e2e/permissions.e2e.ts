import type { BrowserContext, Page } from '@playwright/test';

import { callTool, expect, reply, scriptOpenAI, test } from './fixtures';

const MODEL = 'openai/gpt-6-luna';

const CARD = 'Tell Sidekick what to do instead';

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

async function send(panel: Page, text: string) {
  const box = panel.getByRole('textbox');

  await box.fill(text);
  await box.press('Enter');
}

async function start(context: BrowserContext, openPanel: () => Promise<Page>, page: string) {
  const panel = await openPanel();
  const opener = context.pages().find((candidate) => candidate.url().endsWith('/e2e-open.html'));

  if (!opener) throw new Error('No opener tab');

  await opener.goto(page);
  await opener.bringToFront();
  await connect(panel);

  return panel;
}

function clickTurn(bodies: string[], url: string, done: string, id: string) {
  return [
    callTool('tabs_open', { url }, `call_open_${id}`),
    () =>
      Promise.resolve(
        callTool('click', { tab_id: tabOf(bodies.at(-1)), x: 5, y: 5 }, `call_click_${id}`),
      ),
    reply(done),
  ];
}

function card(panel: Page) {
  return panel.getByRole('region', { name: /^Allow Sidekick to/ });
}

function grants(page: Page) {
  return page.evaluate(
    async () => (await chrome.storage.local.get('permission:grants'))['permission:grants'],
  );
}

test('asks before clicking off the chat’s site, remembers Always, and Revoke asks again', async ({
  context,
  openPanel,
  origin,
  extensionId,
}) => {
  const site = new URL(origin('a')).host;
  const script: Parameters<typeof scriptOpenAI>[1] = [];
  const { bodies } = await scriptOpenAI(context, script);
  const url = `${origin('a')}/tabs.html`;

  script.push(...clickTurn(bodies, url, 'Clicked once.', '1'));

  const panel = await start(context, openPanel, `${origin('b')}/rows.html`);

  await send(panel, 'Click the page');

  await expect(card(panel)).toBeVisible({ timeout: 20_000 });
  await expect(card(panel)).toContainText(`Allow Sidekick to click and type on ${site}?`);
  await expect.poll(() => bodies.length).toBe(2);

  await panel.setViewportSize({ width: 320, height: 640 });

  const fits = await card(panel).evaluate((element) => element.scrollWidth <= element.clientWidth);

  expect(fits).toBe(true);

  await card(panel).screenshot({ path: test.info().outputPath('permission-card.png') });
  await card(panel).getByRole('button', { name: 'Always allow' }).click();
  await expect(panel.getByText('Clicked once.')).toBeVisible();
  await expect(card(panel)).toHaveCount(0);

  const cdp = await context.newCDPSession(panel);

  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await panel.reload();

  await expect
    .poll(() => panel.evaluate(() => window.sidekick.tools.get('click') !== undefined))
    .toBe(true);

  expect(await grants(panel)).toEqual([
    { action: 'input', resource: site, created: expect.any(Number) },
  ]);

  script.push(...clickTurn(bodies, url, 'Clicked unasked.', '2'));
  await expect(panel.getByRole('textbox')).toBeVisible();
  await panel.getByRole('button', { name: 'New chat' }).click();
  await send(panel, 'Click it again');
  await expect(panel.getByText('Clicked unasked.')).toBeVisible({ timeout: 20_000 });
  await expect(card(panel)).toHaveCount(0);

  const options = await context.newPage();

  await options.setViewportSize({ width: 320, height: 800 });
  await options.goto(`chrome-extension://${extensionId}/options.html#permissions`);

  const allowed = options.getByRole('list', { name: 'Always allowed' });

  await expect(allowed).toContainText(`Click and type on ${site}`);
  await expect(allowed).toContainText('Last used');

  await options.screenshot({ path: test.info().outputPath('options-permissions.png') });

  await allowed.getByRole('button', { name: `Revoke input ${site}` }).click();
  await expect(allowed.getByRole('listitem')).toHaveCount(0);

  script.push(...clickTurn(bodies, url, 'Asked again.', '3'));
  await panel.getByRole('button', { name: 'New chat' }).click();
  await send(panel, 'And once more');
  await expect(card(panel)).toBeVisible({ timeout: 20_000 });
  await card(panel).getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.getByText('Asked again.')).toBeVisible();
  expect(await grants(panel)).toEqual([]);
});

test('a plain Deny ends the turn, and Plan offers no click tool', async ({
  context,
  openPanel,
  origin,
}) => {
  const script: Parameters<typeof scriptOpenAI>[1] = [];
  const { bodies } = await scriptOpenAI(context, script);

  script.push(...clickTurn(bodies, `${origin('a')}/tabs.html`, 'Unused.', '1').slice(0, 2));

  const panel = await start(context, openPanel, `${origin('b')}/rows.html`);

  await send(panel, 'Click the page');
  await expect(card(panel)).toBeVisible({ timeout: 20_000 });
  await expect(card(panel).getByRole('textbox', { name: CARD })).toBeVisible();
  await card(panel).getByRole('button', { name: 'Deny' }).click();
  await expect(panel.getByText('Denied')).toBeVisible();
  await expect.poll(() => bodies.length).toBe(2);

  await panel.getByRole('button', { name: 'New chat' }).click();
  await panel.getByRole('combobox', { name: 'Mode' }).click();
  await panel.getByRole('option', { name: 'Plan' }).click();
  await expect(panel.getByRole('combobox', { name: 'Mode' })).toHaveText('Plan');

  script.push(reply('A plan.'));
  await send(panel, 'Plan a click');
  await expect(panel.getByText('A plan.')).toBeVisible({ timeout: 20_000 });

  const tools = (JSON.parse(bodies.at(-1) ?? '{}') as { tools?: { name: string }[] }).tools ?? [];

  expect(tools.map(({ name }) => name)).toContain('snapshot');
  expect(tools.map(({ name }) => name)).not.toContain('click');

  expect(await panel.evaluate(() => chrome.storage.local.get('permission:mode'))).toEqual({
    'permission:mode': 'plan',
  });
});
