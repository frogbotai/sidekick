import { expect, test } from './fixtures';

test('loads with the Web Store ID', ({ extensionId }) => {
  expect(extensionId).toBe('kilnglameccalibejghopglodbidhkmj');
});

test('opens the side panel styled like FrogBot', async ({ openPanel }) => {
  const panel = await openPanel();

  await expect(panel.getByRole('heading', { name: 'Sidekick' })).toBeVisible();
  await expect(panel.locator('html')).toHaveAttribute('data-fb-theme', 'system');

  const base = await panel.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--theme-base-0').trim(),
  );

  expect(base).not.toBe('');

  await expect(panel.locator('.sidekick-panel')).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
});

test('follows the stored theme, live and before first render', async ({ openPanel }) => {
  const panel = await openPanel();
  const html = panel.locator('html');

  await expect(html).toHaveAttribute('data-fb-theme', 'system');
  await panel.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
  await expect(html).toHaveAttribute('data-fb-theme', 'dark');
  await panel.reload();
  await expect(html).toHaveAttribute('data-fb-theme', 'dark');
});
