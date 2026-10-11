import path from 'node:path';

import { type BrowserContext, chromium, type Page, test as base } from '@playwright/test';

const BUILD = path.resolve(import.meta.dirname, '../.output/chrome-mv3-e2e');

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  openPanel: () => Promise<Page>;
}

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${BUILD}`, `--load-extension=${BUILD}`],
    });

    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    await use(new URL(worker.url()).host);
  },
  openPanel: async ({ context, extensionId }, use) => {
    await use(async () => {
      const opener = await context.newPage();

      await opener.goto(`chrome-extension://${extensionId}/e2e-open.html`);

      const panel = context.waitForEvent('page', (page) => page.url().endsWith('/sidepanel.html'));

      await opener.getByRole('button', { name: 'Open side panel' }).click();

      return panel;
    });
  },
});

export { expect } from '@playwright/test';
