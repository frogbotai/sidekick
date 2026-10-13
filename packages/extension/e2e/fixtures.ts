import path from 'node:path';

import type * as provider from '@frogbotai/sidekick-core/provider';
import { type BrowserContext, chromium, type Page, test as base } from '@playwright/test';
import type { streamText } from 'ai';

import type { SidekickWorker } from '../src/entrypoints/sidepanel/worker';

declare global {
  interface Window {
    sidekick: { worker: SidekickWorker; provider: typeof provider; streamText: typeof streamText };
  }
}

/** The folder WXT builds into; `extensionBuild` names a folder inside it. */
export const OUTPUT = path.resolve(import.meta.dirname, '../.output');

/** Options a Playwright config can set for these fixtures. */
export interface Options {
  /** The `.output` folder of the build under test. */
  extensionBuild: string;
}

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  openPanel: () => Promise<Page>;
}

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';

export const test = base.extend<Fixtures & Options>({
  extensionBuild: ['chrome-mv3-e2e', { option: true }],
  context: async ({ extensionBuild }, use) => {
    const build = path.join(OUTPUT, extensionBuild);
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
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
