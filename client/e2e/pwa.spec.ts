import { expect, test } from '@playwright/test';

// These run against the production build served by the real server (see
// playwright.config.ts), so the generated service worker and web app manifest
// are live — the same artifacts a browser uses to offer "Install app".

test('exposes an installable web app manifest', async ({ page, request }) => {
  await page.goto('/');

  const href = await page.getAttribute('link[rel="manifest"]', 'href');
  expect(href).toBeTruthy();

  const res = await request.get(href!);
  expect(res.ok()).toBeTruthy();

  const manifest = await res.json();
  expect(manifest.name).toBe('Manhunt');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBeTruthy();

  // Installability requires both a 192px and a 512px icon.
  const sizes: string[] = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
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

test('the offline fallback does not shadow server routes', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
    timeout: 15_000,
  });

  // A navigation to /health while the worker controls the page must reach the
  // server (JSON), not be rewritten to the cached app shell by the SPA
  // navigation fallback. Guards the navigateFallbackDenylist in vite.config.ts.
  const res = await page.goto('/health');
  expect(res?.ok()).toBeTruthy();
  expect(await res?.json()).toEqual({ ok: true });
});
