import type { Browser, Page } from '@playwright/test';
import { expect } from './harness.ts';

/** A spot on the map, as Playwright's geolocation takes it. */
export interface Spot {
  latitude: number;
  longitude: number;
}

/** Amsterdam's Dam square — where the Hunter stands. */
export const HUNTER_AT: Spot = { latitude: 52.372, longitude: 4.9041 };
/** ~5 m north of the Hunter: inside the 15 m Catch radius. */
export const HIDER_AT: Spot = { latitude: 52.3720449, longitude: 4.9041 };

/**
 * Ready up in `page`. A click that lands before the Game's socket is open is
 * refused without a reply, so it is repeated until the Game has the player ready.
 */
export async function readyUp(page: Page): Promise<void> {
  await expect(async () => {
    const ready = page.getByRole('button', { name: "I'm ready" });
    if (await ready.isVisible()) await ready.click();
    await expect(page.getByRole('button', { name: "I'm not ready" })).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

/** The Host creates a Game in `page`; returns its Join code. */
export async function hostGame(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Ada');
  await page.getByRole('button', { name: /create game/i }).click();
  const codeChip = page.locator('.room-code__value');
  await expect(codeChip).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  return (await codeChip.textContent()) ?? '';
}

/** Bo joins the Game in a browser of their own, standing at `geolocation`, and readies up. */
export async function joinAsBo(browser: Browser, origin: string, code: string, geolocation: Spot) {
  const context = await browser.newContext({ baseURL: origin, geolocation, permissions: ['geolocation'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Your name').fill('Bo');
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await readyUp(page);
  return { context, page };
}

/** The Host readies up once Bo is in; the Game can then start. */
export async function readyHost(page: Page): Promise<void> {
  await expect(page.getByRole('list', { name: 'Hiders' })).toContainText('Bo');
  await readyUp(page);
  await expect(page.getByRole('button', { name: /start game/i })).toBeEnabled();
}
