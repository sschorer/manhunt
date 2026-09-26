import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CatchConfirmedEvent, Game } from '../../shared/index.ts';
import type { GameSnapshot } from '../game/game.ts';
import { connect, createGame, joinGame, lobbyWhere, stubFor, type Received } from './testing.workers.ts';

/** The anchor the players are placed around. */
const BASE = { lat: 0, lng: 0 };
/** ~5.6 m north of the anchor — well inside the 15 m Catch radius. */
const NEAR = { lat: 0.00005, lng: 0 };
/** ~1.1 km north of the anchor — well outside it. */
const FAR = { lat: 0.01, lng: 0 };

const catches = (frame: Received) => frame.t === 'catch_confirmed';

/** An active Game with the Host (a Hunter) at the anchor and Bo (a Hider) at `boAt`. */
async function placedGame(boAt: { lat: number; lng: number }) {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  expect(await hostSocket.request('start_game', {})).toMatchObject({ ok: true });

  hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, ...BASE });
  boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, ...boAt });
  // Both fixes have landed once each side sees its own in a `game_state`.
  const own = (playerId: string) => (frame: Received) =>
    frame.t === 'game_state' && playerId in (frame.d as { positions: Record<string, unknown> }).positions;
  await hostSocket.next(own(host.playerId));
  await boSocket.next(own(bo.playerId));

  return { host, bo, hostSocket, boSocket };
}

/** The Game's persisted snapshot, read straight out of its SQLite row. */
async function storedSnapshot(gameId: string): Promise<GameSnapshot> {
  const row = await runInDurableObject(stubFor(gameId), (_room, state) =>
    state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM game WHERE id = 1').toArray()[0],
  );
  return JSON.parse(row!.snapshot) as GameSnapshot;
}

describe('GameRoom Catch', () => {
  it('confirms a Catch in range, tells everyone and turns the Hider into a Hunter', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame(NEAR);

    const reply = await hostSocket.request('claim_catch', {
      gameId: host.game.id,
      hunterId: host.playerId,
      targetId: bo.playerId,
    });

    expect(reply).toMatchObject({
      ok: true,
      catch: { gameId: host.game.id, hunterId: host.playerId, targetId: bo.playerId, at: expect.any(String) },
    });
    // The caught Hider hears about their own Catch.
    expect((await boSocket.next(catches)).d as CatchConfirmedEvent).toMatchObject({
      hunterId: host.playerId,
      targetId: bo.playerId,
    });
    const flipped = (game: Game) => game.players.some((p) => p.id === bo.playerId && p.role === 'hunter');
    await boSocket.next(lobbyWhere(flipped));
    await hostSocket.next(lobbyWhere(flipped));
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('keeps the Catch and the new Hunter across an eviction', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame(NEAR);
    expect(
      await hostSocket.request('claim_catch', {
        gameId: host.game.id,
        hunterId: host.playerId,
        targetId: bo.playerId,
      }),
    ).toMatchObject({ ok: true });

    expect((await storedSnapshot(host.game.id)).catches).toEqual([
      { hunterId: host.playerId, targetId: bo.playerId, at: expect.any(String) },
    ]);

    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
    await evictDurableObject(stubFor(host.game.id));
    const back = await connect(host.game.id, bo.token);

    const { game } = (await back.next(lobbyWhere())).d as { game: Game };
    expect(game.players.find((p) => p.id === bo.playerId)?.role).toBe('hunter');
    back.ws.close(1000, 'done');
  });

  it('rejects a claim on a Hider out of range and leaves the Game as it was', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame(FAR);

    const reply = await hostSocket.request('claim_catch', {
      gameId: host.game.id,
      hunterId: host.playerId,
      targetId: bo.playerId,
    });

    expect(reply).toMatchObject({ ok: false, code: 'out_of_range' });
    expect((await storedSnapshot(host.game.id)).catches ?? []).toEqual([]);
    expect((await storedSnapshot(host.game.id)).seats.find((s) => s.playerId === bo.playerId)?.role).toBe('hider');
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('rejects a Hider claiming a Catch of their own', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame(NEAR);

    const reply = await boSocket.request('claim_catch', {
      gameId: host.game.id,
      hunterId: bo.playerId,
      targetId: host.playerId,
    });

    expect(reply).toMatchObject({ ok: false, code: 'not_hunter' });
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it("rejects a claim that names someone else as the Hunter", async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame(NEAR);

    // Bo tries to make the Host catch them — the socket, not the payload, says
    // who is claiming.
    const reply = await boSocket.request('claim_catch', {
      gameId: host.game.id,
      hunterId: host.playerId,
      targetId: bo.playerId,
    });

    expect(reply).toMatchObject({ ok: false, code: 'invalid_payload' });
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });
});
