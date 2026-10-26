import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['e2e/**/*.test.js'], testTimeout: 60000, hookTimeout: 60000 },
});
