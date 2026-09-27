import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

/** A `game_state` view as it arrives on a page's socket. */
interface StateFrame {
  gameId: string;
  positions: Record<string, { lat: number; lng: number; recordedAt: string }>;
  reveal?: boolean;
}

const HOST_POSITION = { latitude: 52.372, longitude: 4.9041 };
/** ~90 m north of the Host: inside the Hunter's proximity radius, so a reveal reads out. */
const GUEST_POSITION = { latitude: 52.3728, longitude: 4.9041 };

// Reveals every 10 s instead of every 3 min, so the spec sees them without
// sitting out the default cadence.
test.use({ geolocation: HOST_POSITION, permissions: ['geolocation'], workerVars: { PING_INTERVAL_S: '10' } });
// Two players walk a whole match start here before the first reveal is counted out.
test.setTimeout(60_000);

/**
 * Every `game_state` the page receives, in order. Registered before the page
 * opens its socket, so the Hunter's whole stream is on record and a leak before
 * the first reveal could not hide.
 */
function gameStates(page: Page): StateFrame[] {
  const frames: StateFrame[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const text = String(payload);
      if (!text.startsWith('{')) return;
      const frame = JSON.parse(text) as { t?: string; d?: StateFrame };
      if (frame.t === 'game_state' && frame.d) frames.push(frame.d);
    });
  });
  return frames;
}

test('a Ping reveal shows the Hunter where the Hider is, and tells the Hider', async ({
  browser,
  page,
  workerOrigin,
}) => {
  const hiderContext = await browser.newContext({
    baseURL: workerOrigin,
    geolocation: GUEST_POSITION,
    permissions: ['geolocation'],
  });
  const hider = await hiderContext.newPage();
  const hunterSaw = gameStates(page);

  try {
    await page.goto('/');
    await page.getByLabel('Your name').fill('Ada');
    await page.getByRole('button', { name: /create game/i }).click();
    const codeChip = page.locator('.room-code__value');
    await expect(codeChip).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    const code = (await codeChip.textContent()) ?? '';

    await hider.goto('/');
    await hider.getByLabel('Your name').fill('Bo');
    await hider.getByLabel('Room code').fill(code);
    await hider.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Hiders' })).toContainText('Bo');

    await hider.getByRole('button', { name: "I'm ready" }).click();
    await page.getByRole('button', { name: "I'm ready" }).click();
    const start = page.getByRole('button', { name: /start game/i });
    await expect(start).toBeEnabled();
    await start.click();

    // Between reveals the Hunter has no Hider to point at.
    await expect(page.getByTestId('hunter-hud')).toBeVisible();
    await expect(page.getByText(/no hider nearby/i)).toBeVisible();

    // The first reveal puts the Hider on the Hunter's readout…
    await expect(page.getByText(/hider within/i)).toBeVisible({ timeout: 30_000 });
    // …and tells the Hider they were seen.
    await expect(hider.getByTestId('hider-hud')).toContainText(/just revealed to the hunters/i, {
      timeout: 30_000,
    });

    // The Hider's coordinates only ever reached the Hunter in a reveal.
    const withTheHider = hunterSaw.filter((state) =>
      Object.values(state.positions).some((p) => p.lat === GUEST_POSITION.latitude),
    );
    expect(withTheHider.length).toBeGreaterThan(0);
    for (const state of withTheHider) expect(state.reveal).toBe(true);
  } finally {
    await hiderContext.close();
  }
});
