import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './harness.ts';

/** The Hunter's phone. */
const HUNTER_POSITION = { latitude: 52.372, longitude: 4.9041 };
/** The Hider's phone, ~89 m north of the Hunter: inside the proximity radius. */
const HIDER_POSITION = { latitude: 52.3728, longitude: 4.9041 };

/** The Worker runs with a 10 s Grace period, so a Seat can be waited out inside a test. */
const GRACE_MS = 10_000;

test.use({
  geolocation: HUNTER_POSITION,
  permissions: ['geolocation'],
  ruleVars: { DISCONNECT_GRACE_S: String(GRACE_MS / 1_000) },
});
// Two players walk a whole Lobby, and one of them sits out a Grace period.
test.setTimeout(90_000);

/** The Hider's own phone, in its own browser. */
async function hiderPhone(
  browser: { newContext: (options: object) => Promise<BrowserContext> },
  workerOrigin: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: workerOrigin,
    geolocation: HIDER_POSITION,
    permissions: ['geolocation'],
  });
  return { context, page: await context.newPage() };
}

/** Play a Game up to the moment both players are on the match screen. */
async function startedGame(hunter: Page, hider: Page): Promise<void> {
  await hunter.goto('/');
  await hunter.getByLabel('Your name').fill('Ada');
  await hunter.getByRole('button', { name: /create game/i }).click();
  const codeChip = hunter.locator('.room-code__value');
  await expect(codeChip).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);

  await hider.goto('/');
  await hider.getByLabel('Your name').fill('Bo');
  await hider.getByLabel('Room code').fill((await codeChip.textContent()) ?? '');
  await hider.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(hunter.getByRole('list', { name: 'Hiders' })).toContainText('Bo');

  await hider.getByRole('button', { name: "I'm ready" }).click();
  await hunter.getByRole('button', { name: "I'm ready" }).click();
  const start = hunter.getByRole('button', { name: /start game/i });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(hunter.getByTestId('hunter-hud')).toBeVisible();
  await expect(hider.getByTestId('hider-hud')).toBeVisible();
}

test('a Hider whose page comes back mid-Game keeps the Seat and is handed the running Game', async ({
  browser,
  page,
  workerOrigin,
}) => {
  const { context: hiderContext, page: hider } = await hiderPhone(browser, workerOrigin);
  const readout = hider.locator('p.proximity');

  try {
    await startedGame(page, hider);
    // A Hider may see the Hunters live, and does.
    await expect(readout).toContainText(/hunter within/i);
    const seat = await hider.evaluate(() => localStorage.getItem('manhunt.seat'));

    // The socket goes with the page; the Game holds the Seat for its Grace period,
    // and the client reconnects to it with nothing of the Game left in memory.
    await hider.reload();

    // Everything on screen now came from the snapshot the reconnect was given:
    // the running Game, this Hider's own side of it, and where the Hunter is.
    await expect(hider.getByTestId('hider-hud')).toBeVisible();
    await expect(readout).toContainText(/hunter within/i);
    expect(await hider.evaluate(() => localStorage.getItem('manhunt.seat'))).toBe(seat);
    // The Hunter plays on throughout.
    await expect(page.getByTestId('hunter-hud')).toBeVisible();
  } finally {
    await hiderContext.close();
  }
});

test('a Hider who stays away past the Grace period loses the Seat and lands back on the join screen', async ({
  browser,
  page,
  workerOrigin,
}) => {
  const { context: hiderContext, page: hider } = await hiderPhone(browser, workerOrigin);

  try {
    await startedGame(page, hider);

    // The phone is gone for good — nobody reclaims the Seat before the Game
    // releases it on its alarm.
    await hider.close();
    await page.waitForTimeout(GRACE_MS + 3_000);

    // Coming back to the same browser, Seat and all: the Game turns the socket
    // away and the client forgets the Seat it was holding.
    const back = await hiderContext.newPage();
    await back.goto('/');

    await expect(back.getByRole('button', { name: /create game/i })).toBeVisible({ timeout: 30_000 });
    // The join screen is also up while the page is still connecting, so wait for the Seat to go.
    await expect.poll(() => back.evaluate(() => localStorage.getItem('manhunt.seat'))).toBeNull();
  } finally {
    await hiderContext.close();
  }
});
