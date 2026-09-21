import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most moved specs are plain .test.js; a couple (finding-action-label,
    // impact-band) are core-only TS specs that came from root tests/*.test.ts
    // (see root vitest.config.js's own comment on that pattern) and moved here
    // flattened alongside the rest, so both extensions need to be picked up.
    include: ['test/**/*.test.js', 'test/*.test.ts'],
    globals: true,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      include: ['src/**'],
      // src/vendor/** is third-party decompressor code (fflate, fzstd) kept
      // as plain JS per AGENTS.md; exclude it the same way the root config
      // does so it isn't counted as uncovered source.
      exclude: ['src/vendor/**'],
    },
  },
});
