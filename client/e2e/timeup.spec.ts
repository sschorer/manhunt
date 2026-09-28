import { expect, test } from './harness.ts';
import { HIDER_AT, HUNTER_AT, hostGame, joinAsBo, readyHost } from './players.ts';

// A Game that lasts 8 s instead of 30 min, so the spec sees it end on its own.
test.use({ geolocation: HUNTER_AT, permissions: ['geolocation'], workerVars: { GAME_DURATION_S: '8' } });

/**
 * The other way a Game ends: the game length runs out with a Hider still free,
 * and the Hiders win. Nobody does anything but start the Game and wait.
 */
test('ends the Game with the Hiders winning, on every screen', async ({ browser, page, workerOrigin }) => {
  const code = await hostGame(page);
  const bo = await joinAsBo(browser, workerOrigin, code, HIDER_AT);

  try {
    await readyHost(page);
    await page.getByRole('button', { name: /start game/i }).click();
    await expect(bo.page.getByTestId('hider-hud')).toBeVisible();

    for (const player of [page, bo.page]) {
      await expect(player.getByTestId('game-over').getByRole('heading', { name: 'HIDERS WIN' })).toBeVisible({
        timeout: 20_000,
      });
    }
  } finally {
    await bo.context.close();
  }
});
