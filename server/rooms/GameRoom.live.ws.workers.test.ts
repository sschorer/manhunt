import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { GameStateEvent } from '../../shared/index.ts';
import { DEFAULT_GRACE_MS } from '../game/game.ts';
import { alarmOf, connect, createGame, joinGame, lobbyWhere, stubFor, type Received } from './testing.workers.ts';

/** Matches a `game_state` whose event satisfies `check`. */
function stateWhere(check: (event: GameStateEvent) => boolean = () => true) {
  return (frame: Received) => frame.t === 'game_state' && check(frame.d as GameStateEvent);
}

/** The Host (a Hunter) and Bo (a Hider), both connected and ready. */
async function readySeats() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  return { host, bo, hostSocket, boSocket };
}

async function startedGame() {
  const seats = await readySeats();
  expect(await seats.hostSocket.request('start_game', {})).toMatchObject({ ok: true });
  return seats;
}

describe('GameRoom live play', () => {
  it("starts the Game on the Host's request and tells everyone", async () => {
    const { hostSocket, boSocket } = await readySeats();

    const reply = await hostSocket.request('start_game', {});

    expect(reply).toMatchObject({ ok: true, game: { status: 'active', startedAt: expect.any(String) } });
    await boSocket.next(lobbyWhere((game) => game.status === 'active'));
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it("sends a Hider's accepted position to the Hiders and keeps it from the Hunters", async () => {
    const { host, bo, hostSocket, boSocket } = await startedGame();

    boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.1, lng: 4.3 });

    const hiderView = await boSocket.next(stateWhere((event) => bo.playerId in event.positions));
    expect(hiderView.d).toMatchObject({ gameId: host.game.id, positions: { [bo.playerId]: { lat: 52.1, lng: 4.3 } } });
    expect((await hostSocket.next(stateWhere())).d).toEqual({ gameId: host.game.id, positions: {} });
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('restores positions from the sockets after the Game hibernates, and never stores them', async () => {
    const { host, bo, hostSocket, boSocket } = await startedGame();
    boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.1, lng: 4.3 });
    await boSocket.next(stateWhere((event) => bo.playerId in event.positions));
    const stub = stubFor(host.game.id);
    const stored = await runInDurableObject(stub, (_room, state) =>
      state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM game').one().snapshot,
    );
    expect(stored).not.toContain('52.1');

    await evictDurableObject(stub);
    hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, lat: 52.2, lng: 4.4 });

    const view = await boSocket.next(stateWhere((event) => host.playerId in event.positions));
    expect((view.d as GameStateEvent).positions[bo.playerId]).toMatchObject({ lat: 52.1, lng: 4.3 });
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });
});

// The Worker test config sets DISCONNECT_GRACE_S=20, PING_INTERVAL_S=60 and GAME_DURATION_S=600.
describe('GameRoom rule overrides from Worker variables', () => {
  it('sends the configured ping interval and game length with the Game', async () => {
    const host = await createGame();

    expect(host.game.rules).toEqual({ pingIntervalMs: 60_000, gameDurationMs: 600_000 });
  });

  it('holds a dropped Seat for the configured Grace period', async () => {
    const host = await createGame();
    const socket = await connect(host.game.id, host.token);
    await socket.next(lobbyWhere());
    const droppedAt = Date.now();

    socket.ws.close(1000, 'gone');

    await vi.waitFor(async () => expect(await alarmOf(host.game.id)).not.toBeNull());
    const alarm = (await alarmOf(host.game.id))!;
    expect(alarm).toBeGreaterThanOrEqual(droppedAt + 20_000);
    expect(alarm).toBeLessThan(droppedAt + DEFAULT_GRACE_MS);
  });
});
