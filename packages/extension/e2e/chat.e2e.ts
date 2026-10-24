import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { callTool, callTools, expect, reply, scriptOpenAI, test } from './fixtures';

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

test('sends a prompt, then renames and deletes the chat from the nav drawer', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, [reply('Hi there.')]);

  const panel = await openPanel();

  await panel.setViewportSize({ width: 400, height: 760 });
  await connect(panel);
  await send(panel, 'Say hi');
  await expect(panel.getByText('Hi there.')).toBeVisible();

  await panel.getByRole('button', { name: 'Open navigation' }).click();

  const nav = panel.locator('.fb-nav-shell');
  const row = nav.getByRole('link', { name: 'Open tabs' });

  await expect(row).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('button', { name: 'Chat actions' }).click();
  await panel.getByRole('menuitem', { name: 'Rename' }).click();

  const rename = panel.getByRole('dialog', { name: 'Rename chat' });

  await rename.getByLabel('Chat title').fill('Greetings');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(nav.getByRole('link', { name: 'Greetings' })).toBeVisible();
  await expect(panel.locator('.sidekick-panel__title')).toHaveText('Greetings');

  await nav.getByRole('button', { name: 'Chat actions' }).click();
  await panel.getByRole('menuitem', { name: 'Delete' }).click();

  await panel
    .getByRole('dialog', { name: 'Delete chat?' })
    .getByRole('button', { name: 'Delete' })
    .click();

  await expect(nav.getByRole('link', { name: 'Greetings' })).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'Chats' })).toBeVisible();
  await expect(panel.getByText('Hi there.')).toHaveCount(0);

  expect(await panel.evaluate(() => window.sidekick.engine?.sessions.list())).toEqual([]);
});

async function toolView(panel: Page) {
  const titles = panel.locator('[data-part="tool"] .fb-tool-card__title');
  const screenshot = panel.locator('[data-part="tool"]', {
    has: panel.getByText('Took a screenshot', { exact: true }),
  });

  const header = screenshot.locator('.fb-tool-card__header');

  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('img', { name: 'screenshot result' })).toHaveCount(0);
  await header.click();

  const image = panel.getByRole('img', { name: 'screenshot result' });

  await expect(image).toBeVisible();

  return {
    titles: await titles.allTextContents(),
    src: await image.getAttribute('src'),
    width: await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
  };
}

test('snapshot and screenshot cards: the page title, the screenshot as an image, the same after a reload', async ({
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

  expect(live.titles).toEqual([
    `Opened ${new URL(origin()).hostname}`,
    'Read Five thousand rows',
    'Took a screenshot',
  ]);

  expect(live.src).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
  expect(live.width).toBeGreaterThan(0);

  await panel.reload();
  await expect(panel.getByText('Looked at the rows.')).toBeVisible();

  expect(await toolView(panel)).toEqual(live);
});

test('navigate and snapshot sent together on one tab: the snapshot reads the new page (331)', async ({
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
    () => {
      const tab_id = tabOf(bodies.at(-1));

      return Promise.resolve(
        callTools([
          { name: 'navigate', input: { tab_id, url: `${origin()}/color.html` }, callID: 'call_go' },
          { name: 'snapshot', input: { tab_id }, callID: 'call_snap' },
        ]),
      );
    },
    reply('Read the new page.'),
  ]);

  const panel = await openPanel();

  await connect(panel);
  await send(panel, 'Open rows, then go to the color page and read it');
  await expect(panel.getByText('Read the new page.')).toBeVisible({ timeout: 20_000 });

  await expect(panel.locator('[data-part="tool"] .fb-tool-card__title')).toContainText([
    'Read Color',
  ]);

  expect(bodies.at(-1)).toContain('color.html');
  expect(bodies.at(-1)).not.toContain('Five thousand rows');
});

function watchQueued(panel: Page) {
  return panel.evaluate(() => {
    const seen = { queued: false };
    const check = () => {
      seen.queued ||= [...document.querySelectorAll('[role="status"]')].some((element) =>
        element.textContent?.includes('Queued'),
      );
    };

    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    Object.assign(window, { seenQueued: seen });
  });
}

function sawQueued(panel: Page) {
  return panel.evaluate(
    () => (window as unknown as { seenQueued: { queued: boolean } }).seenQueued.queued,
  );
}

test('a second panel window streams the same chat, and only its own message there is queued', async ({
  context,
  openPanel,
  extensionId,
}) => {
  let release = () => {};

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  await scriptOpenAI(context, [
    async () => {
      await held;

      return reply('Answer from window A.');
    },
    reply('Answer for window B.'),
  ]);

  const first = await openPanel();

  await connect(first);
  await watchQueued(first);
  await send(first, 'Question from window A');
  await expect(first.getByRole('button', { name: 'Stop' })).toBeVisible();

  const second = await context.newPage();

  await second.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(second.getByText('Question from window A')).toBeVisible();

  await send(second, 'Question from window B');

  const queued = second.getByRole('status').filter({ hasText: 'Queued' });

  await expect(queued).toContainText('Question from window B');
  await expect(first.getByText('Question from window A')).toBeVisible();
  expect(await sawQueued(first)).toBe(false);

  release();

  await expect(first.getByText('Answer from window A.')).toBeVisible();
  await expect(second.getByText('Answer from window A.')).toBeVisible();
  await expect(second.getByText('Answer for window B.')).toBeVisible();
  await expect(queued).toHaveCount(0);
  expect(await sawQueued(first)).toBe(false);
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

  await panel.getByRole('button', { name: 'Open navigation' }).click();
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
