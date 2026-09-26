import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, createGame, joinGame, lobbyWhere } from './testing.workers.ts';

/** Everything the Game wrote to the console while a test ran. */
function captureLogs() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  return () => lines.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameRoom logging', () => {
  it('records the Game lifecycle and rejected connections, and never a name or a position', async () => {
    const logs = captureLogs();

    // A whole Game: created by Ada, joined by Bo, started, and played with real fixes.
    const host = await createGame();
    const bo = await joinGame(host.game.roomCode);
    const hostSocket = await connect(host.game.id, host.token);
    const boSocket = await connect(host.game.id, bo.token);
    await hostSocket.next(lobbyWhere());
    await boSocket.next(lobbyWhere());
    await hostSocket.request('set_ready', { ready: true });
    await boSocket.request('set_ready', { ready: true });
    expect(await hostSocket.request('start_game', {})).toMatchObject({ ok: true });
    boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.1, lng: 4.3 });
    await boSocket.next((frame) => frame.t === 'game_state');
    // A connection nobody holds a Seat for, turned away at the door.
    const turnedAway = await connect(host.game.id, 'not-a-seat-token');
    expect(await turnedAway.closed).toBe(4001);

    const written = logs();
    expect(written).toContain('"event":"game_created"');
    expect(written).toContain('"event":"game_started"');
    expect(written).toContain('"event":"connection_rejected"');
    expect(written).toContain('"code":4001');
    expect(written).not.toContain('Ada');
    expect(written).not.toContain('Bo');
    expect(written).not.toContain('52.1');
    expect(written).not.toContain('4.3');
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });
});
