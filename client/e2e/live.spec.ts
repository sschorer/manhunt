import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

interface GameState {
  gameId: string;
  positions: Record<string, { lat: number; lng: number; recordedAt: string }>;
}

// Each browser's captured location. Playwright feeds it to watchPosition, so the
// real client GPS capture streams it as `position_update`.
const HOST_POSITION = { latitude: 52.372, longitude: 4.9041 };
const GUEST_POSITION = { latitude: 52.3731, longitude: 4.8922 };

test.use({ geolocation: HOST_POSITION, permissions: ['geolocation'] });

/**
 * Resolve with the first `game_state` this page receives that shows a player at
 * `position`. Registered before the page opens its socket, so no frame is missed.
 */
function positionSeenBy(page: Page, position: { latitude: number; longitude: number }): Promise<GameState> {
  return new Promise((resolve) => {
    page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        const text = String(payload);
        if (!text.startsWith('{')) return;
        const frame = JSON.parse(text) as { t?: string; d?: GameState };
        if (frame.t !== 'game_state' || !frame.d) return;
        const seen = Object.values(frame.d.positions).some(
          (p) => p.lat === position.latitude && p.lng === position.longitude,
        );
        if (seen) resolve(frame.d);
      });
    });
  });
}

test('the Host starts the Game and a Hider sees the Hunter move live', async ({ browser, page, workerOrigin }) => {
  const guestContext = await browser.newContext({
    baseURL: workerOrigin,
    geolocation: GUEST_POSITION,
    permissions: ['geolocation'],
  });
  const guest = await guestContext.newPage();
  const hunterSeenByHider = positionSeenBy(guest, HOST_POSITION);
  const hiderSeenByHider = positionSeenBy(guest, GUEST_POSITION);

  try {
    await page.goto('/');
    await page.getByLabel('Your name').fill('Ada');
    await page.getByRole('button', { name: /create game/i }).click();
    const codeChip = page.locator('.room-code__value');
    await expect(codeChip).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    const code = (await codeChip.textContent()) ?? '';

    await guest.goto('/');
    await guest.getByLabel('Your name').fill('Bo');
    await guest.getByLabel('Room code').fill(code);
    await guest.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Hiders' })).toContainText('Bo');

    await guest.getByRole('button', { name: "I'm ready" }).click();
    await page.getByRole('button', { name: "I'm ready" }).click();
    const start = page.getByRole('button', { name: /start game/i });
    await expect(start).toBeEnabled();
    await start.click();

    // Each player now sees the match from their own side.
    await expect(page.getByTestId('hunter-hud')).toBeVisible();
    await expect(guest.getByTestId('hider-hud')).toBeVisible();

    // The Hider receives the Hunter's live position, and their own.
    const state = await hunterSeenByHider;
    expect(Object.values(state.positions)).toContainEqual(
      expect.objectContaining({ lat: HOST_POSITION.latitude, lng: HOST_POSITION.longitude }),
    );
    await hiderSeenByHider;
  } finally {
    await guestContext.close();
  }
});
