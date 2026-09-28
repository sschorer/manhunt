import { PROTOCOL_VERSION } from '../../shared/version.ts';
import { expect, test } from './harness.ts';

// The PWA as a browser sees it, served by the real Worker from the production
// build: the generated service worker and the web app manifest are live — the
// same artifacts that make the browser offer "Install app".

test('exposes an installable web app manifest', async ({ page, request }) => {
  await page.goto('/');

  const href = await page.getAttribute('link[rel="manifest"]', 'href');
  expect(href).toBeTruthy();

  const res = await request.get(href!);
  expect(res.ok()).toBeTruthy();

  const manifest = (await res.json()) as {
    name: string;
    display: string;
    start_url: string;
    icons: { sizes: string }[];
  };
  expect(manifest.name).toBe('Manhunt');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBeTruthy();

  // Installability requires both a 192px and a 512px icon.
  const sizes = manifest.icons.map((icon) => icon.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
});

test('SPA deep links serve the app shell', async ({ page }) => {
  // `not_found_handling: "single-page-application"` on Cloudflare, and the asset
  // Worker's own fallback on the Docker target.
  const res = await page.goto('/lobby/AB2C');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'MANHUNT' })).toBeVisible();
});

test('registers a service worker that controls the page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'MANHUNT' })).toBeVisible();

  // clientsClaim() in the generated worker takes control of the open page once
  // it activates.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 15_000,
  });
});

test('boots the app shell offline once the worker is installed', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'MANHUNT' })).toBeVisible();

  // Wait for the worker to precache the shell and take control.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 15_000,
  });

  // Cut the network and reload: the shell must render from the precache alone.
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'MANHUNT' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('the offline fallback does not shadow the Worker routes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 15_000,
  });

  // A navigation to /health while the worker controls the page must reach the
  // Worker (JSON), not be rewritten to the cached app shell by the SPA
  // navigation fallback. Guards the navigateFallbackDenylist in vite.config.ts,
  // which is built from the same route list the Worker answers (shared/routes.ts).
  const res = await page.goto('/health');
  expect(res?.ok()).toBeTruthy();
  expect(await res?.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
});
