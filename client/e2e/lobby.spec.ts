import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

const JOIN_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/** Create a Game as `name` and return its Join code once the Lobby shows. */
async function createAsHost(page: Page, name = 'Ada'): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: /create game/i }).click();
  const joinCode = page.locator('.room-code__value');
  await expect(joinCode).toHaveText(JOIN_CODE);
  return (await joinCode.textContent()) ?? '';
}

async function joinAs(page: Page, code: string, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.locator('.room-code__value')).toHaveText(code);
}

test('a Host creates a Game and sees the Lobby with its Join code', async ({ page }) => {
  // Registered before the Game exists, so the snapshot sent on connect is not missed.
  const snapshot = new Promise<unknown>((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (String(payload).includes('lobby_update')) resolve(JSON.parse(String(payload)));
      });
    });
  });

  const joinCode = await createAsHost(page);
  await expect(page.getByRole('list', { name: 'Hunters' })).toContainText('Ada');

  // The Game accepted the Seat cookie and `Origin` and sent its snapshot.
  expect(await snapshot).toMatchObject({
    t: 'lobby_update',
    d: { game: { roomCode: joinCode, players: [{ name: 'Ada', isHost: true }] } },
  });
});

test('a player joins by Join code, picks a side and gets ready, and the Host sees it', async ({
  browser,
  page,
  workerOrigin,
}) => {
  const code = await createAsHost(page);
  const guestContext = await browser.newContext({ baseURL: workerOrigin });
  const guest = await guestContext.newPage();

  try {
    await joinAs(guest, code, 'Bo');
    await expect(page.getByRole('list', { name: 'Hiders' })).toContainText('Bo');

    await guest.getByRole('button', { name: 'hunter', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Hunters' })).toContainText('Bo');

    await guest.getByRole('button', { name: "I'm ready" }).click();
    await expect(page.getByRole('img', { name: 'Bo is ready' })).toBeVisible();
    await expect(page.getByText('2 players · 1 not ready')).toBeVisible();
  } finally {
    await guestContext.close();
  }
});

test("reloading the page in the Lobby keeps the player's Seat", async ({ page }) => {
  const code = await createAsHost(page);

  await page.reload();

  await expect(page.locator('.room-code__value')).toHaveText(code);
  await expect(page.getByRole('list', { name: 'Hunters' })).toContainText('Ada (you)');
});

test("leaving returns to the join screen and removes the player from everyone's Lobby", async ({
  browser,
  page,
  workerOrigin,
}) => {
  const code = await createAsHost(page);
  const guestContext = await browser.newContext({ baseURL: workerOrigin });
  const guest = await guestContext.newPage();

  try {
    await joinAs(guest, code, 'Bo');
    await expect(page.getByRole('list', { name: 'Hiders' })).toContainText('Bo');

    await guest.getByRole('button', { name: 'Leave' }).click();

    await expect(guest.getByRole('button', { name: /create game/i })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Hiders' })).toContainText('No hiders yet');
    // The Seat is forgotten: a reload stays on the join screen.
    await guest.reload();
    await expect(guest.getByRole('button', { name: /create game/i })).toBeVisible();
    await expect(guest.locator('.room-code__value')).toHaveCount(0);
  } finally {
    await guestContext.close();
  }
});
