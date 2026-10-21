import { defineConfig } from 'vitest/config';
import { localEnv } from './scripts/local-env.ts';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'core', include: ['packages/core/src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['apps/api/test/**/*.test.ts'],
          env: localEnv,
          globalSetup: ['apps/api/test/globalSetup.ts'],
        },
      },
      {
        // Runs against the whole Compose stack (`npm run test:stack`), so `npm test` skips it.
        extends: true,
        test: {
          name: 'stack',
          include: ['ops/test/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
