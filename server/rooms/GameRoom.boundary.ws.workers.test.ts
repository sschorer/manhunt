import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BoundaryWarningEvent, Game, GameStateEvent } from '../../shared/index.ts';
import { connect, createGame, joinGame, lobbyWhere, readyCy, stubFor, type Received } from './testing.workers.ts';

/** A tight Boundary at the origin, so a fix is unambiguously in or out. */
const BOUNDARY = { center: { lat: 0, lng: 0 }, radiusM: 100 };
const INSIDE = { lat: 0, lng: 0 };
/** ~1.1 km north of the centre — comfortably outside the 100 m circle. */
const OUTSIDE = { lat: 0.01, lng: 0 };

const warnings = (frame: Received) => frame.t === 'boundary_warning';
const eliminations = (frame: Received) => frame.t === 'player_eliminated';

/** An active Game with a Boundary, the Host (a Hunter), Bo and Cy (Hiders), all connected. */
async function fencedGame() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  expect(await hostSocket.request('set_boundary', { boundary: BOUNDARY })).toMatchObject({ ok: true });
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  const { cySocket } = await readyCy(host.game);
  expect(await hostSocket.request('start_game', {})).toMatchObject({ ok: true });
  const fix = (playerId: string, at: { lat: number; lng: number }) => ({
    gameId: host.game.id,
    playerId,
    ...at,
  });
  return { host, bo, hostSocket, boSocket, cySocket, fix };
}

describe('GameRoom Boundary', () => {
  it('warns the player who left the Boundary and still eliminates them after an eviction', async () => {
    const { host, bo, hostSocket, boSocket, cySocket, fix } = await fencedGame();

    boSocket.send('position_update', fix(bo.playerId, OUTSIDE));

    const warning = (await boSocket.next(warnings)).d as BoundaryWarningEvent;
    expect(warning).toMatchObject({
      gameId: host.game.id,
      playerId: bo.playerId,
      warnings: 1,
      warningsRemaining: 0,
    });

    // The Game is evicted between the warning and the fix that acts on it.
    await evictDurableObject(stubFor(host.game.id));
    boSocket.send('position_update', fix(bo.playerId, OUTSIDE));

    expect((await hostSocket.next(eliminations)).d).toMatchObject({
      gameId: host.game.id,
      playerId: bo.playerId,
      reason: 'boundary',
      at: expect.any(String),
    });
    await hostSocket.next(
      lobbyWhere((game) => game.players.some((p) => p.id === bo.playerId && p.eliminated === true)),
    );
    hostSocket.ws.close(1000, 'done');
    cySocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('keeps an eliminated player out of play across an eviction', async () => {
    const { host, bo, hostSocket, boSocket, cySocket, fix } = await fencedGame();
    boSocket.send('position_update', fix(bo.playerId, OUTSIDE));
    await boSocket.next(warnings);
    boSocket.send('position_update', fix(bo.playerId, OUTSIDE));
    await boSocket.next(eliminations);

    await evictDurableObject(stubFor(host.game.id));
    const back = await connect(host.game.id, bo.token);

    const { game } = (await back.next(lobbyWhere())).d as { game: Game };
    expect(game.players.find((p) => p.id === bo.playerId)?.eliminated).toBe(true);

    // Nothing they report is accepted any more, while the Game plays on around them.
    back.send('position_update', fix(bo.playerId, INSIDE));
    hostSocket.send('position_update', fix(host.playerId, INSIDE));

    const view = await back.next((frame) => {
      return frame.t === 'game_state' && host.playerId in (frame.d as GameStateEvent).positions;
    });
    expect((view.d as GameStateEvent).positions).not.toHaveProperty(bo.playerId);
    hostSocket.ws.close(1000, 'done');
    cySocket.ws.close(1000, 'done');
    back.ws.close(1000, 'done');
  });
});
