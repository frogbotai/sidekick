import type { Page } from '@playwright/test';

import { DARK_BACKGROUND, unreadableText } from './contrast';
import { expect, reply, scriptOpenAI, test } from './fixtures';

const PLACEHOLDER = 'Ask anything, / for commands…';

async function connect(panel: Page) {
  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();

  await panel.evaluate(async () => {
    await window.sidekick.provider.credentials.add({
      providerID: 'openai',
      label: 'e2e',
      value: { type: 'key', key: 'sk-good' },
    });

    await chrome.storage.local.set({ model: 'openai/gpt-6-luna' });
  });

  await expect(panel.getByRole('textbox')).toBeVisible();
}

async function send(panel: Page, text: string) {
  const box = panel.getByRole('textbox');

  await box.fill(text);
  await box.press('Enter');
}

function drawer(panel: Page) {
  return panel.locator('.fb-nav-shell');
}

async function openNav(panel: Page) {
  await panel.getByRole('button', { name: 'Open navigation' }).click();
  await expect(drawer(panel)).toHaveAttribute('data-nav-state', 'mobile-nav-open');
}

function tinyText(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter(
        (element) =>
          element.checkVisibility() &&
          !/(^|\s)fb-/.test(element.getAttribute('class') ?? '') &&
          [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()) &&
          parseFloat(getComputedStyle(element).fontSize) < 12,
      )
      .map((element) => `${element.className || element.tagName}: ${element.textContent?.trim()}`),
  );
}

test('loads with the Web Store ID', ({ extensionId }) => {
  expect(extensionId).toBe('kilnglameccalibejghopglodbidhkmj');
});

test('opens the side panel styled like FrogBot', async ({ openPanel }) => {
  const panel = await openPanel();
  const html = panel.locator('html');
  const background = panel.locator('.sidekick-panel');

  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();
  await expect(panel.getByRole('heading')).toHaveCount(0);
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(background).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(html).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect.poll(() => unreadableText(panel)).toEqual([]);

  await panel.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(background).toHaveCSS('background-color', DARK_BACKGROUND);
  await expect(html).toHaveCSS('background-color', DARK_BACKGROUND);
  await expect.poll(() => unreadableText(panel)).toEqual([]);
});

test('follows the stored theme, live and before first render', async ({ openPanel }) => {
  const panel = await openPanel();
  const html = panel.locator('html');

  await expect(html).toHaveAttribute('data-theme', 'light');
  await panel.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await panel.reload({ waitUntil: 'commit' });
  await panel.waitForFunction(() => document.body);
  expect(await panel.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect(panel.locator('.sidekick-panel')).toHaveCSS('background-color', DARK_BACKGROUND);
});

test('the nav drawer opens from its toggle, closes on Escape and the backdrop, and opens each view', async ({
  context,
  openPanel,
}) => {
  const panel = await openPanel();

  await panel.setViewportSize({ width: 400, height: 760 });
  await expect(drawer(panel)).toHaveAttribute('data-nav-state', 'mobile-nav-closed');

  await openNav(panel);
  await panel.keyboard.press('Escape');
  await expect(drawer(panel)).toHaveAttribute('data-nav-state', 'mobile-nav-closed');

  await openNav(panel);
  await panel.locator('.fb-nav-backdrop').click({ position: { x: 380, y: 400 } });
  await expect(drawer(panel)).toHaveAttribute('data-nav-state', 'mobile-nav-closed');

  for (const name of ['Providers', 'Agents', 'Commands']) {
    await openNav(panel);
    await drawer(panel).getByRole('button', { name, exact: true }).click();
    await expect(drawer(panel)).toHaveAttribute('data-nav-state', 'mobile-nav-closed');
    await expect(panel.getByRole('region', { name, exact: true })).toBeVisible();
    await expect(panel.locator('.sidekick-panel__title')).toHaveText(name);
  }

  await openNav(panel);
  await drawer(panel).getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Connect a provider' })).toBeVisible();
  await expect(panel.locator('.sidekick-panel__title')).toHaveText('New chat');

  await openNav(panel);

  const options = context.waitForEvent('page');

  await drawer(panel).getByRole('link', { name: 'Settings' }).click();
  expect((await options).url()).toMatch(/\/options\.html$/);
  await expect(panel.locator('.sidekick-panel')).toHaveCount(1);
});

test('a chat picked in the nav opens, and the open one is marked', async ({
  context,
  openPanel,
}) => {
  await scriptOpenAI(context, [reply('First answer.'), reply('Second answer.')]);

  const panel = await openPanel();

  await connect(panel);
  await send(panel, 'First');
  await expect(panel.getByText('First answer.')).toBeVisible();
  await panel.getByRole('button', { name: 'New chat', exact: true }).click();
  await send(panel, 'Second');
  await expect(panel.getByText('Second answer.')).toBeVisible();

  const chats = drawer(panel).locator('.fb-recent-chats__item').getByRole('link');

  await expect(chats).toHaveCount(2);
  await expect(chats.nth(0)).toHaveAttribute('aria-current', 'page');
  await chats.nth(1).click();
  await expect(panel.getByText('First answer.')).toBeVisible();
  await expect(panel.getByText('Second answer.')).toHaveCount(0);
  await expect(chats.nth(1)).toHaveAttribute('aria-current', 'page');
});

test('the Chats section stays collapsed across reloads, in chrome.storage.local', async ({
  openPanel,
}) => {
  const panel = await openPanel();
  const toggle = drawer(panel).getByRole('button', { name: 'Chats' });

  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await expect
    .poll(() => panel.evaluate(() => chrome.storage.local.get('nav:frogbot-nav-section:chats')))
    .toEqual({ 'nav:frogbot-nav-section:chats': { collapsed: true } });

  await panel.reload();

  await expect(drawer(panel).getByRole('button', { name: 'Chats' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('the composer has the placeholder and FrogBot’s mode select', async ({ openPanel }) => {
  const panel = await openPanel();

  await connect(panel);
  await expect(panel.locator('.fb-composer-editor__placeholder')).toHaveText(PLACEHOLDER);

  const mode = panel.getByRole('button', { name: 'Mode' });

  await expect(mode).toHaveClass(/\bfb-composer-select__trigger\b/);
  await expect(mode).toHaveText('Build');
  await mode.click();
  await panel.getByRole('menuitem', { name: 'Plan' }).click();
  await expect(mode).toHaveText('Plan');
});

test('the composer glow turns, and stops under reduced motion', async ({ openPanel }) => {
  const panel = await openPanel();
  const ring = () =>
    panel
      .locator('.fb-composer .fb-glow__ring')
      .evaluate((element) => getComputedStyle(element, '::before').animationName);

  await connect(panel);
  await expect(panel.locator('.fb-composer .fb-glow')).toBeVisible();
  expect(await ring()).toBe('fb-glow-rotate');

  await panel.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(ring).toBe('none');
});

test('Sidekick’s own screens set no text under 12px', async ({
  context,
  extensionId,
  openPanel,
}) => {
  const panel = await openPanel();

  await panel.setViewportSize({ width: 400, height: 760 });
  await connect(panel);
  expect(await tinyText(panel)).toEqual([]);

  for (const name of ['Providers', 'Agents', 'Commands']) {
    await openNav(panel);
    await drawer(panel).getByRole('button', { name, exact: true }).click();
    await expect(panel.getByRole('region', { name, exact: true })).toBeVisible();
    expect(await tinyText(panel)).toEqual([]);
  }

  const options = await context.newPage();

  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('heading', { name: 'Sidekick settings' })).toBeVisible();
  expect(await tinyText(options)).toEqual([]);
});
