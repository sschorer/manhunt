import { test as base } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import type { VapidVariables } from '../../server/push/keys.ts';
import type { RuleVariables } from '../../server/rules.ts';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));

// Runs the built Worker (dist-worker/, serving the PWA from dist/, both produced
// by the `npm run build` that e2e/build.ts runs first) in local workerd, once per
// Playwright worker, and points `baseURL` at it.
export const test = base.extend<object, { workerVars: RuleVariables & VapidVariables; workerOrigin: string }>({
  // The Worker variables this file's specs run against, set with `test.use` at the
  // top of a spec: the rule overrides (`server/rules.ts`) and the Web Push keys
  // (`server/push/keys.ts`). Playwright starts a separate Worker per set of
  // values, so a spec can shorten a timer it would otherwise have to sit out — a
  // Ping reveal every 10 s instead of every 3 min — or turn Web Push on.
  workerVars: [{}, { scope: 'worker', option: true }],
  workerOrigin: [
    async ({ workerVars }, use) => {
      const harness = createTestHarness({
        root: rootDir,
        workers: [{ configPath: 'dist-worker/wrangler.json', vars: { ...workerVars } }],
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
