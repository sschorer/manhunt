import { runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRACE_MS } from '../game/game.ts';
import {
  alarmOf,
  alarmSoon,
  connect,
  createGame,
  deletionOf,
  joinGame,
  lobbyWhere,
  stubFor,
} from './testing.workers.ts';

/** The Host's and a joined Hider's Seats, both connected and past their first snapshot. */
async function twoSeats() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  return { host, bo, hostSocket, boSocket };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameRoom Lobby', () => {
  it('tells every connected Seat when a player joins', async () => {
    const host = await createGame();
    const hostSocket = await connect(host.game.id, host.token);
    await hostSocket.next(lobbyWhere());

    const bo = await joinGame(host.game.roomCode);

    expect((await hostSocket.next(lobbyWhere())).d).toEqual({ game: bo.game });
    hostSocket.ws.close(1000, 'done');
  });

  it('answers a Lobby request and tells everyone about the change', async () => {
    const { bo, hostSocket, boSocket } = await twoSeats();

    const reply = await boSocket.request('set_ready', { ready: true });

    expect(reply).toMatchObject({ ok: true, playerId: bo.playerId });
    await hostSocket.next(lobbyWhere((game) => game.players.some((p) => p.id === bo.playerId && p.ready)));
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('closes the older socket for the same Seat with 4003 and keeps the Seat on the newer one', async () => {
    const host = await createGame();
    const first = await connect(host.game.id, host.token);
    await first.next(lobbyWhere());

    const second = await connect(host.game.id, host.token);

    expect(await first.closed).toBe(4003);
    await second.next(lobbyWhere());
    expect(await second.request('set_ready', { ready: true })).toMatchObject({ ok: true });
    // No Grace period started: only the Game's deletion is on the alarm.
    expect(await alarmOf(host.game.id)).toBe(deletionOf(host.game));
    second.ws.close(1000, 'done');
  });

  it('releases a dropped Seat on the alarm after its Grace period and rejects its return with 4001', async () => {
    const { host, bo, hostSocket, boSocket } = await twoSeats();

    boSocket.ws.close(1000, 'gone');
    await alarmSoon(host.game.id);
    const later = Date.now() + DEFAULT_GRACE_MS + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect(await runDurableObjectAlarm(stubFor(host.game.id))).toBe(true);
    vi.restoreAllMocks();

    await hostSocket.next(lobbyWhere((game) => game.players.every((p) => p.id !== bo.playerId)));
    const back = await connect(host.game.id, bo.token);
    expect(await back.closed).toBe(4001);
    hostSocket.ws.close(1000, 'done');
  });

  it('keeps a dropped Seat that reconnects within its Grace period', async () => {
    const { host, bo, hostSocket, boSocket } = await twoSeats();

    boSocket.ws.close(1000, 'gone');
    await alarmSoon(host.game.id);
    const back = await connect(host.game.id, bo.token);

    expect((await back.next(lobbyWhere())).d).toMatchObject({ game: { players: [{}, { id: bo.playerId }] } });
    await vi.waitFor(async () => expect(await alarmOf(host.game.id)).toBe(deletionOf(host.game)));
    hostSocket.ws.close(1000, 'done');
    back.ws.close(1000, 'done');
  });

  it('closes a leaving Seat with 4001 after its reply and tells everyone', async () => {
    const { host, bo, hostSocket, boSocket } = await twoSeats();

    expect(await boSocket.request('leave_game', undefined)).toEqual({ ok: true });

    expect(await boSocket.closed).toBe(4001);
    await hostSocket.next(lobbyWhere((game) => game.players.length === 1));
    const back = await connect(host.game.id, bo.token);
    expect(await back.closed).toBe(4001);
    hostSocket.ws.close(1000, 'done');
  });
});
