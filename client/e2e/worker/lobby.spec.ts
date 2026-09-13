import { expect, test } from './harness.ts';

test('a Host creates a Game and sees the Lobby with its Join code', async ({ page }) => {
  // Registered before the Game exists, so the snapshot sent on connect is not missed.
  const snapshot = new Promise<unknown>((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        if (String(payload).includes('lobby_update')) resolve(JSON.parse(String(payload)));
      });
    });
  });

  await page.goto('/');
  await page.getByLabel('Your name').fill('Ada');
  await page.getByRole('button', { name: /create game/i }).click();

  const joinCode = page.locator('.room-code__value');
  await expect(joinCode).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  await expect(page.getByRole('list', { name: 'Hunters' })).toContainText('Ada');

  // The Game accepted the Seat cookie and `Origin` and sent its snapshot.
  expect(await snapshot).toMatchObject({
    t: 'lobby_update',
    d: { game: { roomCode: await joinCode.textContent(), players: [{ name: 'Ada', isHost: true }] } },
  });
});
