import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Specs are mostly .test.js; a few core-only specs (finding-action-label,
    // impact-band) are .test.ts, so both extensions are included.
    include: ['test/**/*.test.js', 'test/*.test.ts'],
    globals: true,
    // Generates the gitignored tuning reference (src/docs-content/) from its
    // pin before any test reads it; shared with the root config.
    globalSetup: ['../../scripts/vitest-tuning-docs-setup.mjs'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      include: ['src/**'],
      // src/vendor/** is third-party decompressor code (fflate, fzstd) kept
      // as plain JS per AGENTS.md; exclude it the same way the root config
      // does so it isn't counted as uncovered source. src/docs-content/**
      // is markdown reference content bundled for the MCP doc tools, not
      // code; vitest 5's coverage-v8 parses every include-glob
      // match as JS to remap uncovered files and errors noisily on it.
      exclude: ['src/vendor/**', 'src/docs-content/**'],
    },
  },
});
