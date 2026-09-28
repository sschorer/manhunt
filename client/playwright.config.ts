import { defineConfig, devices } from '@playwright/test';

// Allow pointing at the pre-installed Chromium in managed environments.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: { trace: 'on-first-retry' },
  // Builds the PWA and the Worker once, before any spec runs. There is no
  // `webServer`: each Playwright worker gets its own Worker in local workerd from
  // that build output, started by wrangler's createTestHarness() (see
  // e2e/harness.ts), which is also what sets `baseURL`.
  globalSetup: './e2e/build.ts',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } },
    },
  ],
});
