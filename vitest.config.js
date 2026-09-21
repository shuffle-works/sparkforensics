import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    pool: 'threads',
    poolOptions: {
      threads: {
        // Node 26 jsdom regression: experimental webstorage causes test failures
        execArgv: ['--no-experimental-webstorage'],
        // Cap below core count: full concurrency starves jsdom/React view specs
        // of CPU and trips their userEvent timeouts under contention.
        maxThreads: 4,
      },
    },
    environmentMatchGlobs: [['tests/view/**', 'jsdom']],
    environmentOptions: {
      // Real origin for localStorage/postMessage consistency in jsdom
      jsdom: { url: 'http://localhost/' },
    },
    // `tests/*.test.ts` (not recursive): core-only, no-React TS specs directly
    // under tests/, exercised without a JSX transform. tests/view/** has its
    // own recursive glob below.
    include: ['tests/**/*.test.js', 'tests/*.test.ts', 'tests/view/**/*.test.ts', 'tests/view/**/*.test.tsx'],
    setupFiles: ['tests/view/setup.ts'],
    globals: true,
    // Some view tests (React Flow + dagre layout, 3000-row recharts render)
    // outrun the 5000ms default under thread contention; give all the headroom.
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Scope coverage to the browser layer: this run exercises only tests/**
      // (src/**), not packages/core/test/**, so measuring packages/core/src/**
      // would report it as untouched dead code.
      include: ['src/**'],
      exclude: ['src/vendor/**'],
      // Non-blocking floor (issue #53): baseline ~75% statements / 66% branches
      // / 81% functions / 78% lines (src/** only). Not enforced: vitest's
      // coverage.thresholds has no warn-only mode, so setting it exits 1 the
      // moment any metric dips. Wiring a real gate is deferred (see PR).
    },
  },
});
