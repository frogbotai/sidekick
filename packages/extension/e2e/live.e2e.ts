import type { Page } from '@playwright/test';

import { expect, liveBuild, test as base } from './fixtures';

const test = base.extend({
  extensionBuild: async ({ extensionBuild }, use) => use(liveBuild(extensionBuild)),
});

async function clickStop(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const worlds: { id: number; origin: string; auxData?: { type?: string } }[] = [];

  cdp.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
  await cdp.send('Runtime.enable');

  const isolated = () =>
    worlds.find(
      (world) =>
        world.origin.startsWith('chrome-extension://') && world.auxData?.type === 'isolated',
    );

  await expect.poll(isolated).toBeDefined();

  const { result } = await cdp.send('Runtime.evaluate', {
    contextId: isolated()?.id,
    returnByValue: true,
    expression: `(() => {
      const stop = [...document.documentElement.children]
        .map((element) => chrome.dom.openOrClosedShadowRoot(element)?.querySelector('.stop'))
        .find(Boolean);
      const { x, y, width, height } = stop.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    })()`,
  });

  const { x, y } = result.value as { x: number; y: number };

  await page.mouse.click(x, y);
}

test('the live runner runs every step against stand-in sites and reports them', async ({
  context,
  openPanel,
  origin,
}) => {
  test.setTimeout(180_000);

  const site = `${origin()}/live-site.html`;
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  await worker.evaluate((overrides) => chrome.storage.local.set({ liveSiteOverrides: overrides }), {
    github: { url: `${site}?github` },
    mdn: { url: `${origin()}/mdn.html`, navigateTo: `${origin()}/color.html` },
    lexical: { url: `${origin()}/editors.html?lexical` },
    prosemirror: { url: `${origin()}/editors.html?prosemirror` },
    amazon: { url: `${origin()}/amazon.html` },
    gmail: { url: `${site}?gmail` },
  });

  const panel = await openPanel();

  await expect(panel.getByRole('button', { name: 'Run all tests' })).toBeVisible();
  await panel.getByLabel(/Gmail/).check();
  await panel.getByRole('button', { name: 'Run all tests' }).click();

  await expect(panel.getByText(/Now click the red “Stop Sidekick” button/)).toBeVisible({
    timeout: 150_000,
  });

  const front = context.pages().find((page) => page.url() === `${site}?github`);

  if (!front) throw new Error('No front tab');

  await clickStop(front);

  await expect(panel.getByRole('heading', { name: 'Finished' })).toBeVisible({ timeout: 30_000 });

  for (const no of await panel.getByRole('button', { name: 'No' }).all()) await no.click();

  await panel.getByRole('button', { name: 'Copy results' }).click();

  const report = await worker.evaluate(
    async () => (await chrome.storage.local.get('liveReport')).liveReport as string,
  );

  expect(report).toContain('## Live run (ticket 271');
  expect(report).not.toContain('(not settled)');
  expect(report).toContain('| GitHub | ✅ |');
  expect(report).not.toContain('not answered');
  expect(report).toMatch(/\| Stop button \| ✅ \| the trusted click ended the run/);
  expect(report).toMatch(/\| After Stop \| ✅ \|/);

  expect(report).toMatch(
    /\| Group after Stop \| ✅ \| still in the group: GitHub, Lexical playground, ProseMirror demo \|/,
  );

  expect(report).toContain(
    'When copied: in the run’s group: GitHub, Lexical playground, ProseMirror demo; outside it: none',
  );

  expect(report).toMatch(
    /Fill \| ✅ \| “sidekick test” refused \(f\d+e\d+ takes at most 8 characters\), then “sidekick”/,
  );

  expect(report).toMatch(/refused as not a text field/);
  expect(report).toMatch(/field: textbox "Search Amazon" f0e3/);
  expect(report).toMatch(/field: textbox "Name, 4 to 8 characters" f[1-9]\d*e\d+/);
  expect(report).toMatch(/\| Navigate \| ✅ \| to .*color\.html, back, forward/);

  const failed = report.split('\n').filter((line) => line.includes('| ❌ |'));

  expect(failed).toEqual([]);
});

test('a rerun of only MDN, Lexical and ProseMirror passes and keeps the editors in the group', async ({
  context,
  openPanel,
  origin,
}) => {
  test.setTimeout(120_000);

  const mdn = `${origin()}/mdn.html`;
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  await worker.evaluate((overrides) => chrome.storage.local.set({ liveSiteOverrides: overrides }), {
    mdn: { url: mdn, navigateTo: `${origin()}/color.html` },
    lexical: { url: `${origin()}/editors.html?lexical` },
    prosemirror: { url: `${origin()}/editors.html?prosemirror` },
  });

  const panel = await openPanel();

  await panel.getByLabel(/GitHub/).uncheck();
  await panel.getByLabel(/Amazon/).uncheck();
  await panel.getByRole('button', { name: 'Run all tests' }).click();

  await expect(panel.getByText(/Now click the red “Stop Sidekick” button/)).toBeVisible({
    timeout: 100_000,
  });

  const front = context.pages().find((page) => page.url() === `${origin()}/color.html`);

  if (!front) throw new Error('No front tab');

  await clickStop(front);

  await expect(panel.getByRole('heading', { name: 'Finished' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Copy results' }).click();

  const report = await worker.evaluate(
    async () => (await chrome.storage.local.get('liveReport')).liveReport as string,
  );

  expect(report).toContain(
    'Sites: MDN (cross-origin live example), Lexical playground, ProseMirror demo.',
  );

  expect(report).toContain(
    'When copied: in the run’s group: MDN (cross-origin live example), Lexical playground, ProseMirror demo; outside it: none',
  );

  expect(report.split('\n').filter((line) => line.includes('| ❌ |'))).toEqual([]);
});
