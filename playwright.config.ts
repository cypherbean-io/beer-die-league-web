import { defineConfig, devices } from '@playwright/test';

// Runs in the official Playwright image against the test stack (`npm run e2e`, which seeds
// the leagues first; see scripts/e2e.ts). The container shares the web container's network,
// so https://localhost is Caddy, as APP_ORIGIN expects. Caddy's local CA isn't trusted there.
export default defineConfig({
  testDir: 'e2e',
  // Both under playwright-report/, the one directory the e2e service may write.
  outputDir: 'playwright-report/results',
  forbidOnly: true,
  // Every spec signs in from one address, against a budget of 20 codes an hour.
  retries: 0,
  workers: 2,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/html' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'https://localhost',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
});
