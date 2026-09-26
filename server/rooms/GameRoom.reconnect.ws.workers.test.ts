import { runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameStateEvent } from '../../shared/index.ts';
import { alarmOf, connect, FIXES, lobbyWhere, placedGame, stateWhere, stubFor } from './testing.workers.ts';

/** The Worker test config sets DISCONNECT_GRACE_S=20. */
const GRACE_MS = 20_000;

/** Drop a Seat's socket and wait until the Game has armed its Grace period. */
async function drop(socket: { ws: WebSocket }, gameId: string): Promise<void> {
  socket.ws.close(1000, 'signal lost');
  await vi.waitFor(async () => expect(await alarmOf(gameId)).not.toBeNull());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameRoom reconnect during an active Game', () => {
  it('gives a returning Hider the Lobby and the live view a Hider may see', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame();
    await drop(boSocket, host.game.id);

    const back = await connect(host.game.id, bo.token);

    expect((await back.next(lobbyWhere())).d).toMatchObject({ game: { status: 'active' } });
    const view = (await back.next(stateWhere())).d as GameStateEvent;
    expect(view.positions[host.playerId]).toMatchObject(FIXES.host);
    expect(view.positions[bo.playerId]).toMatchObject(FIXES.bo);
    hostSocket.ws.close(1000, 'done');
    back.ws.close(1000, 'done');
  });

  it('cancels the release, so the Seat is still playing when the Grace period would have passed', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame();
    await drop(boSocket, host.game.id);

    const back = await connect(host.game.id, bo.token);
    await back.next(stateWhere());

    // Only the Ping reveal is left to wake for; the Seat's release is off the books.
    expect(await alarmOf(host.game.id)).toBeGreaterThan(Date.now() + GRACE_MS);
    // A step small enough that no elapsed time could make it an implausible jump.
    back.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.100001, lng: 4.3 });
    const own = await back.next(stateWhere((event) => event.positions[bo.playerId]?.lat === 52.100001));
    expect(own.d).toMatchObject({ gameId: host.game.id });
    hostSocket.ws.close(1000, 'done');
    back.ws.close(1000, 'done');
  });

  it('turns the Seat away with 4001 when it comes back after the Grace period', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame();
    await drop(boSocket, host.game.id);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + GRACE_MS + 1_000);
    expect(await runDurableObjectAlarm(stubFor(host.game.id))).toBe(true);
    vi.restoreAllMocks();

    await hostSocket.next(lobbyWhere((game) => game.players.every((p) => p.id !== bo.playerId)));
    const back = await connect(host.game.id, bo.token);
    expect(await back.closed).toBe(4001);
    hostSocket.ws.close(1000, 'done');
  });

  it('forgets the position of a Seat the Game let go', async () => {
    const { host, bo, hostSocket, boSocket } = await placedGame();
    await drop(boSocket, host.game.id);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + GRACE_MS + 1_000);
    expect(await runDurableObjectAlarm(stubFor(host.game.id))).toBe(true);
    vi.restoreAllMocks();
    await hostSocket.next(lobbyWhere((game) => game.players.every((p) => p.id !== bo.playerId)));

    hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, lat: 52.200001, lng: 4.4 });

    const view = (await hostSocket.next(stateWhere((event) => event.positions[host.playerId]?.lat === 52.200001)))
      .d as GameStateEvent;
    expect(view.positions).not.toHaveProperty(bo.playerId);
    hostSocket.ws.close(1000, 'done');
  });
});
