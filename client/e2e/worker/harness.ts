import { test as base } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

const rootDir = fileURLToPath(new URL('../../..', import.meta.url));

// Runs the built Worker (dist-worker/, serving the client from dist-next/, both
// produced by `npm run build:worker-backend`, which the Playwright webServer runs
// first) in local workerd, once per Playwright worker, and points `baseURL` at it.
export const test = base.extend<object, { ruleVars: Record<string, string>; workerOrigin: string }>({
  // Rule overrides (`server/rules.ts`) for the Worker this file's specs run
  // against, set with `test.use` at the top of a spec. Playwright starts a
  // separate Worker per set of values, so a spec can shorten a timer it would
  // otherwise have to sit out — a Ping reveal every 10 s instead of every 3 min.
  ruleVars: [{}, { scope: 'worker', option: true }],
  workerOrigin: [
    async ({ ruleVars }, use) => {
      const harness = createTestHarness({
        root: rootDir,
        workers: [{ configPath: 'dist-worker/wrangler.json', vars: ruleVars }],
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
