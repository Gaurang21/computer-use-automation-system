import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 60_000,
    setupFiles: ['tests/setup.ts'],
  },
});
