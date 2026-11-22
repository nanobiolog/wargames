import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // long game simulations (hours of game time) run several seconds each under parallel load
    testTimeout: 30_000,
  },
});
