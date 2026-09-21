import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: true,
    testTimeout: 30000,
    // analyze.test.js and export.test.js both call packAndInstall, which runs
    // `npm pack` -> prepack -> vendor-core.mjs + vendor-export-template.mjs.
    // Those scripts write to shared, non-namespaced paths (this package's own
    // vendor-core/ and export-template/, plus the repo root's dist-export/
    // and docs-site/.vitepress/.temp/), so parallel workers running both
    // files at once race each other's writes. The suite is small; serialize
    // files to eliminate that race.
    fileParallelism: false,
  },
});
