import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: true,
    globalSetup: ['../../scripts/vitest-detection-docs-setup.mjs'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      include: ['bin/**'],
    },
  },
});
