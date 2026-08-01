import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Deploying a stack (even locally into workerd) is far slower than a unit
    // test. Alchemy's harness also rides out the Cloudflare cold-start window.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
