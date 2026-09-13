import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const PORT = process.env.E2E_PORT || 3000;
const baseURL = `http://127.0.0.1:${PORT}`;

// Allow pointing at the pre-installed Chromium in managed environments.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: 'worker/**',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } },
    },
    // The new Workers backend, run from the build output by wrangler's
    // createTestHarness() (see e2e/worker/harness.ts), not the webServer below.
    {
      name: 'worker',
      testDir: './e2e/worker',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } },
    },
  ],
  // Build the client (and the Worker), then run the real server which serves
  // dist/ and the Socket.IO endpoint — the same path production uses. The second
  // build switches the client to the Worker backend (dist-next/) and leaves the
  // Worker in dist-worker/ for the `worker` project.
  webServer: {
    command: 'npm run build && npm run build:worker-backend && node server/index.ts',
    cwd: rootDir,
    url: `${baseURL}/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
