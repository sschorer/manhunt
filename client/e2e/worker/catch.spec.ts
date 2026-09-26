import type { Browser } from '@playwright/test';
import { expect, test } from './harness.ts';
import { openSeatSocket } from './seatSocket.ts';
import type { CatchAck, CatchConfirmedEvent, Game } from '../../../shared/index.ts';

/** Amsterdam's Dam square — where the Hunter stands. */
const HUNTER_AT = { latitude: 52.372, longitude: 4.9041 };
/** ~5 m north of the Hunter: inside the 15 m Catch radius. */
const NEAR_AT = { latitude: 52.3720449, longitude: 4.9041 };
/** ~500 m north of the Hunter: well outside it. */
const FAR_AT = { latitude: 52.3764915, longitude: 4.9041 };

test.use({ geolocation: HUNTER_AT, permissions: ['geolocation'] });

function coordinates({ latitude, longitude }: { latitude: number; longitude: number }) {
  return { lat: latitude, lng: longitude };
}

/** Join the Game in a browser of their own, standing at `geolocation`, and ready up. */
async function joinAs(
  browser: Browser,
  origin: string,
  name: string,
  code: string,
  geolocation: { latitude: number; longitude: number },
) {
  const context = await browser.newContext({ baseURL: origin, geolocation, permissions: ['geolocation'] });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Room code').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByRole('button', { name: "I'm ready" }).click();
  return { context, page };
}

/**
 * The Catch, end to end: the Game measures a claim against its own positions,
 * refuses the Hider who is 500 m away and confirms the one standing next to the
 * Hunter, who changes sides on the spot.
 *
 * Two Hiders rather than one moving Hider, because walking 500 m into the
 * Hunter's arms between two fixes is exactly the teleport the Game rejects as
 * implausible. The Hunter claims over their own socket: the UI can only aim a
 * Catch at a Hider it has been shown, and Hiders are only disclosed on a Ping
 * reveal.
 */
test('confirms a Catch in range and refuses one out of range', async ({ browser, page, workerOrigin }) => {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Ada');
  await page.getByRole('button', { name: /create game/i }).click();
  const codeChip = page.locator('.room-code__value');
  await expect(codeChip).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  const code = (await codeChip.textContent()) ?? '';

  const near = await joinAs(browser, workerOrigin, 'Bo', code, NEAR_AT);
  const far = await joinAs(browser, workerOrigin, 'Cy', code, FAR_AT);

  try {
    const hiders = page.getByRole('list', { name: 'Hiders' });
    await expect(hiders).toContainText('Bo');
    await expect(hiders).toContainText('Cy');
    await page.getByRole('button', { name: "I'm ready" }).click();
    await expect(page.getByRole('button', { name: /start game/i })).toBeEnabled();

    const hunter = await openSeatSocket(page);
    const { game } = await hunter.next<{ game: Game }>('lobby_update');
    const idOf = (name: string) => game.players.find((player) => player.name === name)!.id;
    expect(await hunter.request('start_game', {})).toMatchObject({ ok: true });
    await hunter.send('position_update', {
      gameId: hunter.gameId,
      playerId: idOf('Ada'),
      ...coordinates(HUNTER_AT),
    });

    // Both Hiders are in the match, reporting where they stand.
    await expect(near.page.getByTestId('hider-hud')).toBeVisible();
    await expect(far.page.getByTestId('hider-hud')).toBeVisible();

    const claim = (targetId: string) =>
      hunter.request<CatchAck>('claim_catch', { gameId: hunter.gameId, hunterId: idOf('Ada'), targetId });

    // Until every fix has landed the Game has nothing to measure, so both claims
    // are retried; what matters is the answer each one settles on.
    await expect
      .poll(async () => {
        const reply = await claim(idOf('Cy'));
        return reply.ok ? 'confirmed' : reply.code;
      }, { timeout: 20_000 })
      .toBe('out_of_range');

    let confirmed: CatchAck | undefined;
    await expect
      .poll(async () => {
        confirmed = await claim(idOf('Bo'));
        return confirmed.ok;
      }, { timeout: 20_000 })
      .toBe(true);
    expect(confirmed).toMatchObject({
      ok: true,
      catch: { gameId: hunter.gameId, hunterId: idOf('Ada'), targetId: idOf('Bo') },
    });

    // Everyone is told, and the caught Hider is a Hunter from here on.
    expect(await hunter.next<CatchConfirmedEvent>('catch_confirmed')).toMatchObject({
      hunterId: idOf('Ada'),
      targetId: idOf('Bo'),
    });
    await expect(near.page.getByTestId('hunter-hud')).toBeVisible();
    await expect(far.page.getByTestId('hider-hud')).toBeVisible();
  } finally {
    await near.context.close();
    await far.context.close();
  }
});
