import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { releaseVersion } from './scripts/release-version.ts';

// Worker and Durable Object tests, run inside workerd. Two projects:
// - `worker`: normal Worker/host-module tests.
// - `worker-serial`: Durable Object WebSocket tests, which must run with
//   `--max-workers=1 --no-isolate` (see the `test:worker` script).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './deploy/wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Rule overrides that differ from the defaults, so tests can see them take effect.
          DISCONNECT_GRACE_S: '20',
          PING_INTERVAL_S: '60',
          GAME_DURATION_S: '600',
          // A throwaway VAPID pair (`npm run vapid:keys`) so Web Push is on in the
          // tests. Pushes go to whatever the test puts in place of `fetch`.
          VAPID_PUBLIC_KEY: 'BKj0Is4B9JfkdTHC1pMK6rYDKcHnNU1kOElKlpwmkIG4YxMhnShG2QkztefWEwr70zT97YPqIDNjRd83mFIY6uM',
          VAPID_PRIVATE_KEY: 'dEGyK-Cc1CudWvOpZMZMALqu65QutXz22_cmtPh8U04',
          VAPID_SUBJECT: 'mailto:tests@manhunt.example',
        },
      },
    }),
  ],
  define: {
    __MANHUNT_VERSION__: JSON.stringify(releaseVersion()),
  },
  test: {
    coverage: {
      // V8 coverage doesn't work inside workerd.
      provider: 'istanbul',
      include: [
        'server/worker.ts',
        'server/seat.ts',
        'server/rules.ts',
        'server/rooms/**',
        'server/game/**',
        'server/push/**',
        'shared/**',
      ],
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
