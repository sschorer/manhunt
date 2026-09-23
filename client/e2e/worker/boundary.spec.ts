import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';
import { PROTOCOL_VERSION } from '../../../shared/version.ts';

/** A tight Boundary around the Host, so the Hider's fixes are unambiguously out. */
const BOUNDARY = { center: { lat: 52.372, lng: 4.9041 }, radiusM: 100 };
const HOST_POSITION = { latitude: BOUNDARY.center.lat, longitude: BOUNDARY.center.lng };
/** ~800 m west of the centre — comfortably outside the 100 m circle. */
const HIDER_POSITION = { latitude: 52.3721, longitude: 4.8924 };

test.use({ geolocation: HOST_POSITION, permissions: ['geolocation'] });

/**
 * Set the Boundary and start the Game as the Host, over a socket opened inside
 * the Host's own page. Nothing in the UI sets a Boundary yet and the Seat cookie
 * is `HttpOnly`, so the browser has to make the call. The Game replaces the
 * page's own socket (close `4003`), which is harmless here: the player under
 * test is the Hider in the other context.
 */
async function hostFencesAndStarts(page: Page): Promise<void> {
  const gameId = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('manhunt.seat') ?? '{}') as { gameId?: string }).gameId,
  );
  expect(gameId).toBeTruthy();

  await page.evaluate(
    async ({ gameId, boundary, protocol }) => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${scheme}//${location.host}/ws/games/${gameId}?v=${protocol}`);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      const request = async (t: string, id: number, d: unknown): Promise<void> => {
        const replied = new Promise<{ ok?: boolean }>((resolve) => {
          const onMessage = (event: MessageEvent): void => {
            const frame = JSON.parse(String(event.data)) as { re?: number; d?: { ok?: boolean } };
            if (frame.re !== id) return;
            ws.removeEventListener('message', onMessage);
            resolve(frame.d ?? {});
          };
          ws.addEventListener('message', onMessage);
        });
        ws.send(JSON.stringify({ t, id, d }));
        const body = await replied;
        if (!body.ok) throw new Error(`${t} was rejected`);
      };
      await request('set_boundary', 1, { boundary });
      await request('start_game', 2, {});
      // Hold the socket open so the Host's Seat is never seen as dropped.
      (window as unknown as { __hostSocket?: WebSocket }).__hostSocket = ws;
    },
    { gameId, boundary: BOUNDARY, protocol: PROTOCOL_VERSION },
  );
}

test('a Hider who leaves the Boundary is warned, then eliminated', async ({
  browser,
  page,
  workerOrigin,
}) => {
  const hiderContext = await browser.newContext({
    baseURL: workerOrigin,
    geolocation: HIDER_POSITION,
    permissions: ['geolocation'],
  });
  const hider = await hiderContext.newPage();

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
    await expect(page.getByRole('button', { name: /start game/i })).toBeEnabled();

    await hostFencesAndStarts(page);

    // The Hider starts outside the Boundary, so their first fix is warned…
    await expect(hider.getByTestId('hider-hud')).toBeVisible();
    await expect(hider.getByRole('alert')).toContainText(/outside the boundary/i, { timeout: 20_000 });
    await expect(hider.getByRole('alert')).toContainText(/head back now/i);

    // …and the next one, still outside, takes them out of the Game for good.
    await expect(hider.getByRole('alert')).toContainText(/you stayed outside the boundary/i, {
      timeout: 30_000,
    });
    // Out of play: their location is no longer shared with the Game.
    await expect(hider.getByText(/location off/i)).toBeVisible();
  } finally {
    await hiderContext.close();
  }
});
