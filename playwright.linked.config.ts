import { defineConfig } from '@playwright/test';

import type { Options } from './packages/extension/e2e/fixtures';
import base from './playwright.config';

export default defineConfig<Options>({
  ...base,
  use: { ...base.use, extensionBuild: 'chrome-mv3-e2e-linked' },
});
