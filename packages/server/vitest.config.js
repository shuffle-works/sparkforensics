import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // bin.test.js and index.test.js both read/write the same real vendor-core/
    // directory, so parallel workers would race regeneration against cleanup.
    // The suite is small; serialize files to eliminate that race.
    fileParallelism: false,
    globalSetup: ['../../scripts/vitest-detection-docs-setup.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      include: ['index.js', 'lib/**'],
    },
  },
});
