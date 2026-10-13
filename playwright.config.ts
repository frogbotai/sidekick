import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'packages/extension/e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: 'packages/extension/e2e/setup.ts',
  workers: 1,
  outputDir: 'node_modules/.cache/playwright',
});
