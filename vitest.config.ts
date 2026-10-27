import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // npm test builds first; never rediscover the emitted dist/tests copies.
    include: ['tests/**/*.test.ts'],
  },
});
