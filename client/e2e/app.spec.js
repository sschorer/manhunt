import { expect, test } from '@playwright/test';

test('serves a healthy backend', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ ok: true });
});

test('loads the app and connects to the socket', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'MANHUNT' })).toBeVisible();

  // The socket connects same-origin against the real server.
  await expect(page.getByRole('status')).toHaveText(/Connected to server/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('status-dot')).toHaveClass(/status__dot--on/);
});

test('SPA deep links serve the app shell', async ({ page }) => {
  const res = await page.goto('/lobby/ABCD');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'MANHUNT' })).toBeVisible();
});
