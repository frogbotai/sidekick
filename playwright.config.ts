import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'packages/extension/e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  outputDir: 'node_modules/.cache/playwright',
});
