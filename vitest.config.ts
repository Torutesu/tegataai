import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
