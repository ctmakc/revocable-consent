import { configDefaults, defineConfig } from 'vitest/config';

// The whole suite is plain Node: pure logic, a child-process CLI test and an
// opt-in Postgres integration lane. No DOM, no framework, no build step.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests need a database. They are opt-in via RC_INTEGRATION=1
    // (see test/integration/README.md), so `npm test` passes in a clean clone
    // with nothing but Node installed.
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.RC_INTEGRATION ? [] : ['test/integration/**']),
    ],
  },
});
