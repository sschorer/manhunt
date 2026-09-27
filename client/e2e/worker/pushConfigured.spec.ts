import { expect, test } from './harness.ts';

/** A throwaway VAPID pair (`npm run vapid:keys`), so this spec runs with push on. */
const VAPID = {
  VAPID_PUBLIC_KEY: 'BKj0Is4B9JfkdTHC1pMK6rYDKcHnNU1kOElKlpwmkIG4YxMhnShG2QkztefWEwr70zT97YPqIDNjRd83mFIY6uM',
  VAPID_PRIVATE_KEY: 'dEGyK-Cc1CudWvOpZMZMALqu65QutXz22_cmtPh8U04',
  VAPID_SUBJECT: 'mailto:ops@manhunt.example',
};

// A worker-scoped option, so it has to be set for the whole file: this Worker runs
// as a deployment with Web Push configured (`push.spec.ts` is one without).
test.use({ workerVars: VAPID });

test('advertises the public key a player subscribes with', async ({ request }) => {
  const res = await request.get('/api/push/vapid-public-key');

  expect(await res.json()).toEqual({ key: VAPID.VAPID_PUBLIC_KEY });
});

test('never hands out the private key that signs a push', async ({ request }) => {
  const res = await request.get('/api/push/vapid-public-key');

  expect(await res.text()).not.toContain(VAPID.VAPID_PRIVATE_KEY);
});
