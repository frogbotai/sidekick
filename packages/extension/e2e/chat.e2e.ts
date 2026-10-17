import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { callTool, expect, reply, scriptOpenAI, test } from './fixtures';

const SOURCE = path.resolve(import.meta.dirname, '../src');

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

async function send(panel: Page, text: string) {
  const box = panel.getByRole('textbox');

  await box.fill(text);
  await box.press('Enter');
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

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && /\.(tsx?|css|html)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('sends a prompt, then renames and deletes the chat from the drawer', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, [reply('Hi there.')]);

  const panel = await openPanel();

  await connect(panel);
  await send(panel, 'Say hi');
  await expect(panel.getByText('Hi there.')).toBeVisible();

  await panel.getByRole('button', { name: 'Chats' }).click();

  const drawer = panel.getByRole('dialog', { name: 'Chats' });
  const row = drawer.getByRole('button', { name: 'Open tabs' });

  await expect(row).toBeVisible();
  await drawer.getByRole('button', { name: 'Chat actions' }).click();
  await panel.getByRole('menuitem', { name: 'Rename' }).click();

  const rename = panel.getByRole('dialog', { name: 'Rename chat' });

  await rename.getByLabel('Chat title').fill('Greetings');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(drawer.getByRole('button', { name: 'Greetings' })).toBeVisible();

  await drawer.getByRole('button', { name: 'Chat actions' }).click();
  await panel.getByRole('menuitem', { name: 'Delete' }).click();

  await panel
    .getByRole('dialog', { name: 'Delete chat?' })
    .getByRole('button', { name: 'Delete' })
    .click();

  await expect(drawer.getByRole('button', { name: 'Greetings' })).toHaveCount(0);
  await panel.keyboard.press('Escape');
  await expect(panel.getByText('Hi there.')).toHaveCount(0);

  expect(await panel.evaluate(() => window.sidekick.engine?.sessions.list())).toEqual([]);
});

function toolRow(panel: Page, name: string) {
  return panel.getByRole('button', { name: new RegExp(`^${name}\\b`) });
}

async function toolView(panel: Page) {
  const snapshot = toolRow(panel, 'snapshot');
  const screenshot = toolRow(panel, 'screenshot');

  await expect(snapshot).toHaveAttribute('aria-expanded', 'false');
  await expect(screenshot).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('img', { name: 'screenshot result' })).toHaveCount(0);

  await snapshot.click();

  const body = panel
    .locator('[data-part="tool"]', { has: snapshot })
    .locator('.fb-tool-part__body');

  const size = await body.evaluate((element) => ({
    height: element.clientHeight,
    scroll: element.scrollHeight,
    text: element.textContent ?? '',
  }));

  await screenshot.click();

  const image = panel.getByRole('img', { name: 'screenshot result' });

  await expect(image).toBeVisible();

  return {
    rows: await panel.locator('[data-part="tool"] > button').allTextContents(),
    size,
    src: await image.getAttribute('src'),
    width: await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
  };
}

test('snapshot and screenshot results: the snapshot collapsed under its height limit, the screenshot an image, the same after a reload', async ({
  context,
  openPanel,
  origin,
}) => {
  const tabOf = (body: string | undefined) => {
    const found = /tab_id\\*"\s*:\s*(\d+)/.exec(body ?? '')?.[1];

    if (!found) throw new Error(`No tab_id in ${body}`);

    return Number(found);
  };

  const { bodies } = await scriptOpenAI(context, [
    callTool('tabs_open', { url: `${origin()}/rows.html` }, 'call_open'),
    () => Promise.resolve(callTool('snapshot', { tab_id: tabOf(bodies.at(-1)) }, 'call_snap')),
    () => Promise.resolve(callTool('screenshot', { tab_id: tabOf(bodies.at(-1)) }, 'call_shot')),
    reply('Looked at the rows.'),
  ]);

  const panel = await openPanel();

  await connect(panel);
  await send(panel, 'Look at the rows page');
  await expect(panel.getByText('Looked at the rows.')).toBeVisible({ timeout: 20_000 });

  const live = await toolView(panel);

  expect(live.size.height).toBeLessThanOrEqual(240);
  expect(live.size.scroll).toBeGreaterThan(live.size.height);
  expect(live.size.text).toContain('Row 1');
  expect(live.src).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
  expect(live.width).toBeGreaterThan(0);

  await panel.reload();
  await expect(panel.getByText('Looked at the rows.')).toBeVisible();

  expect(await toolView(panel)).toEqual(live);
});

test('a second panel window streams the same chat', async ({ context, openPanel, extensionId }) => {
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  await scriptOpenAI(context, [
    async () => {
      await held;

      return reply('Answer from window A.');
    },
  ]);

  const first = await openPanel();

  await connect(first);
  await send(first, 'Question from window A');
  await expect(first.getByRole('button', { name: 'Stop' })).toBeVisible();

  const second = await context.newPage();

  await second.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(second.getByText('Question from window A')).toBeVisible();

  release();

  await expect(first.getByText('Answer from window A.')).toBeVisible();
  await expect(second.getByText('Answer from window A.')).toBeVisible();
});

test('fits a 320px panel: the chat, the Providers view and the options page', async ({
  context,
  openPanel,
  extensionId,
}) => {
  await scriptOpenAI(context, []);

  const panel = await openPanel();

  await panel.setViewportSize({ width: 320, height: 640 });
  await connect(panel);
  await expect.poll(() => overflows(panel)).toEqual({ page: false, elements: [] });

  await panel.getByRole('button', { name: 'Providers', exact: true }).click();
  await expect(panel.getByText('Keys stay on this device.', { exact: false })).toBeVisible();
  await expect.poll(() => overflows(panel)).toEqual({ page: false, elements: [] });

  const options = await context.newPage();

  await options.setViewportSize({ width: 320, height: 640 });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('heading', { name: 'Sidekick settings' })).toBeVisible();
  await expect.poll(() => overflows(options)).toEqual({ page: false, elements: [] });
});

test('the options page changes the theme, and the panel follows', async ({
  context,
  openPanel,
  extensionId,
}) => {
  const panel = await openPanel();
  const options = await context.newPage();

  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByLabel('Dark').click();

  await expect(options.locator('html')).toHaveAttribute('data-fb-theme', 'dark');
  await expect(panel.locator('html')).toHaveAttribute('data-fb-theme', 'dark');

  expect(await options.evaluate(() => chrome.storage.local.get('theme'))).toEqual({
    theme: 'dark',
  });
});

test('the extension source has no Tailwind and no fb- selector', async () => {
  const files = await sourceFiles(SOURCE);
  const found: string[] = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');

    if (/tailwind|@apply/i.test(text)) found.push(`${file}: tailwind`);

    if (file.endsWith('.css') && /\.fb-/.test(text)) found.push(`${file}: .fb- selector`);

    if (/['"`]\.fb-/.test(text)) found.push(`${file}: .fb- selector`);
  }

  expect(files.length).toBeGreaterThan(10);
  expect(found).toEqual([]);
});
