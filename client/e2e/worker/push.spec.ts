import { hostGame } from './players.ts';
import { expect, test } from './harness.ts';

/**
 * The Lobby's Web Push opt-in on a deployment with no VAPID keys — which is how
 * the release configuration ships, so it is what an operator sees before they run
 * `npm run vapid:keys`. It has to say so rather than fail silently.
 *
 * A deployment that does have keys is `pushConfigured.spec.ts`; delivering a
 * notification needs a real push service, so that end of it is covered inside
 * workerd (`server/rooms/GameRoom.push.ws.workers.test.ts`).
 */

test('offers no VAPID key at all', async ({ request }) => {
  const res = await request.get('/api/push/vapid-public-key');

  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ key: null });
});

test.describe('with notifications allowed', () => {
  // Headless Chromium refuses notifications whatever the context is granted, so
  // the permission — and only the permission — is answered here. What the test is
  // after is everything past it: the toggle asks this Worker for a key and shows
  // the player what its answer means.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
      Notification.requestPermission = () => Promise.resolve('granted');
    });
  });

  test('says notifications are not configured on this server', async ({ page }) => {
    await hostGame(page);

    await page.getByRole('button', { name: /enable game alerts/i }).click();

    await expect(page.getByRole('alert')).toHaveText(/not configured/i);
  });
});

test.describe('with notifications blocked', () => {
  test('offers no button to press, and says why', async ({ page }) => {
    await hostGame(page);

    // A browser that refuses notifications is nothing the app can talk its way
    // out of, so the toggle says where to change it instead of retrying.
    await expect(page.getByRole('alert')).toHaveText(/blocked/i);
    await expect(page.getByRole('button', { name: /enable game alerts/i })).toBeDisabled();
  });
});
