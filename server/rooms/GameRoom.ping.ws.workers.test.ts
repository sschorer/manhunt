import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Game, GameStateEvent } from '../../shared/index.ts';
import { alarmOf, connect, createGame, joinGame, lobbyWhere, stubFor, type Received } from './testing.workers.ts';

/** The Worker test config sets PING_INTERVAL_S=60, so reveals are a minute apart. */
const PING_INTERVAL_MS = 60_000;

/** Matches a `game_state` whose event satisfies `check`. */
function stateWhere(check: (event: GameStateEvent) => boolean) {
  return (frame: Received) => frame.t === 'game_state' && check(frame.d as GameStateEvent);
}

/** An active Game: the Host (a Hunter) and Bo (a Hider), each having reported a fix. */
async function placedGame() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  const started = (await hostSocket.request('start_game', {})) as { ok: boolean; game: Game };
  expect(started).toMatchObject({ ok: true });
  hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, lat: 52.2, lng: 4.4 });
  boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.1, lng: 4.3 });
  await boSocket.next(stateWhere((event) => host.playerId in event.positions && bo.playerId in event.positions));
  return { host, bo, hostSocket, boSocket, startedAt: Date.parse(started.game.startedAt!) };
}

/** Sleep through the next Ping reveal: rewrite the stored deadline into the past. */
async function sleepThroughTheReveal(gameId: string): Promise<void> {
  const stub = stubFor(gameId);
  await runInDurableObject(stub, (_room, state) => {
    const row = state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM game WHERE id = 1').one();
    const snapshot = JSON.parse(row.snapshot) as { pingDeadline: number };
    expect(snapshot.pingDeadline).toBeGreaterThan(Date.now());
    snapshot.pingDeadline = Date.now() - 1_000;
    state.storage.sql.exec('UPDATE game SET snapshot = ? WHERE id = 1', JSON.stringify(snapshot));
  });
  // Evicted, so the Game is rebuilt from that snapshot the next time it wakes.
  await evictDurableObject(stub);
}

describe('GameRoom Ping reveals on the alarm', () => {
  it('points the single alarm at the first Ping reveal when the Game starts', async () => {
    const { hostSocket, boSocket, host, startedAt } = await placedGame();

    expect(await alarmOf(host.game.id)).toBe(startedAt + PING_INTERVAL_MS);
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('reveals the Hiders to the Hunters when the alarm fires, and points it at the next reveal', async () => {
    const { hostSocket, boSocket, host, bo } = await placedGame();
    await sleepThroughTheReveal(host.game.id);

    expect(await runDurableObjectAlarm(stubFor(host.game.id))).toBe(true);

    const revealed = await hostSocket.next(stateWhere((event) => event.reveal === true));
    expect((revealed.d as GameStateEvent).positions[bo.playerId]).toMatchObject({ lat: 52.1, lng: 4.3 });
    await boSocket.next(stateWhere((event) => event.reveal === true));
    expect(await alarmOf(host.game.id)).toBeGreaterThan(Date.now());
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('keeps the alarm on the reveal it has not reached yet when it wakes with nothing due', async () => {
    const { hostSocket, boSocket, host, startedAt } = await placedGame();

    expect(await runDurableObjectAlarm(stubFor(host.game.id))).toBe(true);

    expect(await alarmOf(host.game.id)).toBe(startedAt + PING_INTERVAL_MS);
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });
});
