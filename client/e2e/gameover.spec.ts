import { expect, test } from './harness.ts';
import { HIDER_AT, HUNTER_AT, hostGame, joinAsBo, readyHost } from './players.ts';
import { openSeatSocket } from './seatSocket.ts';
import type { CatchAck, Game, GameOverEvent } from '../../shared/index.ts';

test.use({ geolocation: HUNTER_AT, permissions: ['geolocation'] });

/**
 * The end of a Game, played out on the new backend: catching the last Hider is
 * the Hunters' win, the Game tells everyone with the summary and closes their
 * sockets with `4002`, and the end screen comes back after a reload because the
 * ended Game hands the summary to anyone who connects.
 *
 * The Hunter claims over their own socket: the UI can only aim a Catch at a
 * Hider it has been shown, and Hiders are only disclosed on a Ping reveal.
 */
test('ends the Game when the last Hider is caught, and shows the end screen again after a reload', async ({
  browser,
  page,
  workerOrigin,
}) => {
  const code = await hostGame(page);
  const bo = await joinAsBo(browser, workerOrigin, code, HIDER_AT);

  try {
    await readyHost(page);
    const hunter = await openSeatSocket(page);
    const { game } = await hunter.next<{ game: Game }>('lobby_update');
    const idOf = (name: string) => game.players.find((player) => player.name === name)!.id;
    expect(await hunter.request('start_game', {})).toMatchObject({ ok: true });
    await hunter.send('position_update', {
      gameId: hunter.gameId,
      playerId: idOf('Ada'),
      lat: HUNTER_AT.latitude,
      lng: HUNTER_AT.longitude,
    });
    await expect(bo.page.getByTestId('hider-hud')).toBeVisible();

    // Until Bo's fix has landed the Game has nothing to measure, so the claim is retried.
    await expect
      .poll(async () => {
        const reply = await hunter.request<CatchAck>('claim_catch', {
          gameId: hunter.gameId,
          hunterId: idOf('Ada'),
          targetId: idOf('Bo'),
        });
        return reply.ok;
      }, { timeout: 20_000 })
      .toBe(true);

    const over = await hunter.next<GameOverEvent>('game_over');
    expect(over.summary).toMatchObject({
      gameId: hunter.gameId,
      winner: 'hunters',
      reason: 'all_caught',
      catches: [{ hunterId: idOf('Ada'), targetId: idOf('Bo') }],
      hiders: [{ playerId: idOf('Bo'), name: 'Bo', caught: true }],
    });

    const endScreen = bo.page.getByTestId('game-over');
    await expect(endScreen).toBeVisible();
    await expect(endScreen.getByRole('heading', { name: 'HUNTERS WIN' })).toBeVisible();

    // The Game is over, but it still knows how it went.
    await bo.page.reload();
    await expect(endScreen.getByRole('heading', { name: 'HUNTERS WIN' })).toBeVisible();

    await endScreen.getByRole('button', { name: 'Play again' }).click();
    await expect(bo.page.getByLabel('Your name')).toBeVisible();
    await bo.page.reload();
    await expect(bo.page.getByLabel('Your name')).toBeVisible();
  } finally {
    await bo.context.close();
  }
});
