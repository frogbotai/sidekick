import type { Page } from '@playwright/test';

import { expect, reply, scriptOpenAI, test } from './fixtures';

const MODEL = 'openai/gpt-6-luna';

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

function overflows(page: Page) {
  return page.evaluate(() => {
    const wide = [...document.querySelectorAll('body *')].filter(
      (element) => element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0,
    );

    return {
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      elements: wide
        .filter((element) => getComputedStyle(element).overflowX === 'visible')
        .map((element) => element.className),
    };
  });
}

async function send(panel: Page, text: string) {
  const box = panel.getByRole('textbox');

  await box.fill(text);
  await box.press('Enter');
}

async function pick(panel: Page, id: string) {
  const box = panel.getByRole('textbox');

  await box.fill(`/${id}`);
  await expect(menu(panel).getByRole('option', { name: new RegExp(`^/${id}\\b`) })).toBeVisible();
  await box.press('Enter');
}

function menu(panel: Page) {
  return panel.getByRole('listbox', { name: 'Commands' });
}

function view(panel: Page, name: string) {
  return panel.getByRole('region', { name, exact: true });
}

async function addCommand(panel: Page, name: string, template: string) {
  const form = view(panel, 'Commands').locator('form').last();

  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Template').fill(template);
  await form.getByRole('button', { name: 'Add command' }).click();
}

test('adds, edits and deletes a command template, and refuses a built-in name', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, []);

  const panel = await openPanel();

  await connect(panel);
  await panel.getByRole('button', { name: 'Commands', exact: true }).click();
  await expect(view(panel, 'Commands').getByText('No commands yet.')).toBeVisible();

  await addCommand(panel, 'new', 'Not a new chat');

  await expect(view(panel, 'Commands').getByRole('alert')).toHaveText(
    '/new is already a built-in.',
  );

  await addCommand(panel, 'sum', 'Summarize $1');

  const card = panel.getByRole('region', { name: '/sum' });

  await expect(card.getByText('Summarize $1')).toBeVisible();

  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByLabel('Template').fill('Summarize $1 in one line');
  await card.getByLabel('Description').fill('Summarize a page');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Summarize $1 in one line')).toBeVisible();
  await expect(card.getByText('Summarize a page')).toBeVisible();

  expect(await panel.evaluate(() => chrome.storage.local.get('commands'))).toEqual({
    commands: [
      { name: 'sum', description: 'Summarize a page', template: 'Summarize $1 in one line' },
    ],
  });

  await addCommand(panel, 'sum', 'Again');
  await expect(view(panel, 'Commands').getByRole('alert')).toHaveText('/sum already exists.');

  await card.getByRole('button', { name: 'Delete /sum' }).click();
  await expect(card).toBeHidden();
  await expect(view(panel, 'Commands').getByText('No commands yet.')).toBeVisible();
});

test('lists every agent with its rules and prompt, and an edited prompt survives a reload until Reset', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, []);

  const panel = await openPanel();

  await connect(panel);
  await panel.getByRole('button', { name: 'Agents', exact: true }).click();

  const agents = view(panel, 'Agents');

  for (const name of ['Build', 'Explore', 'Title', 'Compaction']) {
    await expect(agents.getByRole('region', { name: new RegExp(`^${name}`) })).toBeVisible();
  }

  const build = agents.getByRole('region', { name: /^Build/ });
  const explore = agents.getByRole('region', { name: /^Explore/ });
  const prompt = build.getByLabel('Build prompt');

  await expect(prompt).toContainText(
    "You are Sidekick, an AI agent running in the user's browser.",
  );

  await expect(prompt).toContainText("When a permission is denied, don't work around it");
  await expect(explore.getByText('deny * *')).toBeVisible();
  await expect(explore.getByText('allow read *')).toBeVisible();

  await expect(
    agents.getByRole('region', { name: /^Title/ }).getByText('hidden', { exact: true }),
  ).toBeVisible();

  await build.getByRole('button', { name: 'Edit' }).click();
  await build.getByLabel('System prompt').fill('You are Sidekick. Always answer in French.');
  await build.getByRole('button', { name: 'Save' }).click();
  await expect(prompt).toHaveText('You are Sidekick. Always answer in French.');

  await panel.reload();
  await panel.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(prompt).toHaveText('You are Sidekick. Always answer in French.');
  await expect(build.getByText('edited', { exact: true })).toBeVisible();

  await build.getByRole('button', { name: 'Reset to default' }).click();

  await expect(prompt).toContainText(
    "You are Sidekick, an AI agent running in the user's browser.",
  );

  await expect(build.getByRole('button', { name: 'Reset to default' })).toBeHidden();
});

test('fits a 320px panel: the bar and the Commands, Agents and Help views', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, []);

  const panel = await openPanel();

  await panel.setViewportSize({ width: 320, height: 640 });
  await connect(panel);

  await panel.evaluate(() =>
    chrome.storage.local.set({
      commands: [{ name: 'review/a-very-long-command-name', template: 'Review $ARGUMENTS' }],
    }),
  );

  await expect.poll(() => overflows(panel)).toEqual({ page: false, elements: [] });

  for (const name of ['Commands', 'Agents', 'New chat']) {
    await panel.getByRole('button', { name: 'Open navigation' }).click();
    await panel.getByRole('button', { name, exact: true }).click();

    if (name !== 'New chat') await expect(view(panel, name)).toBeVisible();

    await expect.poll(() => overflows(panel)).toEqual({ page: false, elements: [] });
  }

  await pick(panel, 'help');
  await expect(view(panel, 'Help')).toBeVisible();
  await expect.poll(() => overflows(panel)).toEqual({ page: false, elements: [] });
});

test('the / menu lists the built-ins and runs them: /compact, /new, /plan and /help', async ({
  context,
  openPanel,
}) => {
  const { bodies } = await scriptOpenAI(context, [
    reply('Hello back.'),
    reply('## Objective\n- Say hello'),
  ]);

  const panel = await openPanel();

  await connect(panel);
  await panel.getByRole('textbox').fill('/');

  const options = menu(panel).getByRole('option');

  await expect(options.first()).toBeVisible();

  const listed = (await options.allTextContents()).map((text) => /^\/[a-z]+/.exec(text)?.[0]);

  expect(listed).toEqual(['/new', '/connect', '/model', '/plan', '/permissions', '/help']);

  await send(panel, 'Hello');
  await expect(panel.getByText('Hello back.')).toBeVisible({ timeout: 20_000 });

  await pick(panel, 'compact');

  await expect(panel.locator('[data-part="compaction"]')).toHaveAttribute(
    'data-state',
    'completed',
    { timeout: 20_000 },
  );

  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain('You MUST summarize');

  await pick(panel, 'new');
  await expect(panel.getByText('Hello back.')).toBeHidden();
  await expect(panel.getByRole('textbox')).toHaveText('');

  await pick(panel, 'plan');
  await expect(panel.getByRole('button', { name: 'Mode' })).toHaveText('Plan');

  await pick(panel, 'help');

  const help = view(panel, 'Help');

  await expect(help).toBeVisible();
  await expect(help.getByRole('listitem').first()).toContainText('/new');
  await expect(help.getByRole('listitem')).toHaveCount(6);
  expect(bodies).toHaveLength(2);
});

test('a saved template runs with $1 as the user message, and an unknown command is sent as text', async ({
  context,
  openPanel,
}) => {
  const { bodies } = await scriptOpenAI(context, [reply('A summary.'), reply('No such command.')]);

  const panel = await openPanel();

  await connect(panel);

  await panel.evaluate(() =>
    chrome.storage.local.set({
      commands: [{ name: 'sum', description: 'Summarize a page', template: 'Summarize $1' }],
    }),
  );

  await panel.getByRole('textbox').fill('/su');

  await expect(menu(panel).getByRole('option', { name: /^\/sum/ })).toContainText(
    'Summarize a page',
  );

  await send(panel, '/sum "the page"');
  await expect(panel.getByText('A summary.')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText('Summarize the page', { exact: true })).toBeVisible();
  expect(bodies[0]).toContain('Summarize the page');
  expect(bodies[0]).not.toContain('/sum');

  await send(panel, '/unknown hi');
  await expect(panel.getByText('No such command.')).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText('/unknown hi', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain('/unknown hi');
});

test('/model opens the picker or picks a match, and /permissions opens the options page there', async ({
  context,
  openPanel,
}) => {
  const { bodies } = await scriptOpenAI(context, []);

  const panel = await openPanel();

  await connect(panel);

  const trigger = panel.getByRole('button', { name: /GPT-6 Luna/ });

  await expect(trigger).toBeVisible();

  await pick(panel, 'model');
  await expect(panel.getByRole('textbox')).toHaveText('/model ');
  await panel.getByRole('textbox').press('Enter');
  await expect(panel.getByRole('button', { name: /^Select (model|effort)$/ })).toBeVisible();
  await panel.keyboard.press('Escape');

  await send(panel, '/model astra');
  await expect(panel.getByRole('button', { name: /GPT-6 Astra/ })).toBeVisible();

  await expect
    .poll(() => panel.evaluate(async () => (await chrome.storage.local.get('model')).model))
    .toMatch(/^openai\/gpt-6-astra/);

  const options = context.waitForEvent('page', (page) => page.url().includes('options.html'));

  await pick(panel, 'permissions');

  const page = await options;

  expect(new URL(page.url()).hash).toBe('#permissions');
  await expect(page.getByRole('heading', { name: 'Permissions' })).toBeVisible();
  expect(bodies).toHaveLength(0);
});
