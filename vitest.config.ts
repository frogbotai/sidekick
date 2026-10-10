import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: { name: 'unit', include: ['packages/*/src/**/*.spec.{ts,tsx}'] },
      },
    ],
  },
});
