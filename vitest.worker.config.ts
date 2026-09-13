import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { releaseVersion } from './scripts/release-version.ts';

// Worker and Durable Object tests, run inside workerd. Two projects:
// - `worker`: normal Worker/host-module tests.
// - `worker-serial`: Durable Object WebSocket tests, which must run with
//   `--max-workers=1 --no-isolate` (see the `test:worker` script).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './deploy/wrangler.jsonc' } })],
  define: {
    __MANHUNT_VERSION__: JSON.stringify(releaseVersion()),
  },
  test: {
    coverage: {
      // V8 coverage doesn't work inside workerd.
      provider: 'istanbul',
      include: ['server/worker.ts', 'server/seat.ts', 'server/rooms/**', 'server/game/**', 'shared/**'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'worker',
          include: ['server/**/*.workers.test.ts'],
          exclude: ['server/**/*.ws.workers.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'worker-serial',
          include: ['server/**/*.ws.workers.test.ts'],
        },
      },
    ],
  },
});
