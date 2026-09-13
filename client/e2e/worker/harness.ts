import { test as base } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

const rootDir = fileURLToPath(new URL('../../..', import.meta.url));

// Runs the built Worker (dist-worker/, produced by `npm run build`, which the
// Playwright webServer runs first) in local workerd, once per Playwright
// worker, and points `baseURL` at it.
export const test = base.extend<object, { workerOrigin: string }>({
  workerOrigin: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const harness = createTestHarness({
        root: rootDir,
        workers: [{ configPath: 'dist-worker/wrangler.json' }],
      });
      const { url } = await harness.listen();
      await use(url.origin);
      await harness.close();
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ workerOrigin }, use) => use(workerOrigin),
});

export { expect } from '@playwright/test';
