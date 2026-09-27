import { runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RETENTION_MS } from '../game/game.ts';
import { connect, FIXES, NAMES, placedGame, stubFor } from './testing.workers.ts';

/** The Worker test config sets GAME_DURATION_S=600. */
const GAME_DURATION_MS = 600_000;

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

    // A whole Game: created, joined, started, and played with real fixes.
    const { host, hostSocket, boSocket } = await placedGame();
    // A connection nobody holds a Seat for, turned away at the door.
    const turnedAway = await connect(host.game.id, 'not-a-seat-token');
    expect(await turnedAway.closed).toBe(4001);

    const written = logs();
    expect(written).toContain('"event":"game_created"');
    expect(written).toContain('"event":"game_started"');
    expect(written).toContain('"event":"connection_rejected"');
    expect(written).toContain('"code":4001');
    for (const secret of [NAMES.host, NAMES.bo, ...Object.values(FIXES).flatMap((fix) => Object.values(fix))]) {
      expect(written).not.toContain(String(secret));
    }
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('records the Game ending and being deleted, naming nothing but the Game', async () => {
    const { host, hostSocket, boSocket, startedAt } = await placedGame();
    const logs = captureLogs();
    const now = vi.spyOn(Date, 'now');

    // The game length runs out, and a day later the Game is deleted.
    now.mockReturnValue(startedAt + GAME_DURATION_MS);
    await runDurableObjectAlarm(stubFor(host.game.id));
    expect(await hostSocket.closed).toBe(4002);
    expect(await boSocket.closed).toBe(4002);
    now.mockReturnValue(startedAt + GAME_DURATION_MS + RETENTION_MS);
    await runDurableObjectAlarm(stubFor(host.game.id));

    const written = logs();
    expect(written).toContain(`{"event":"game_ended","gameId":"${host.game.id}"}`);
    expect(written).toContain(`{"event":"game_deleted","gameId":"${host.game.id}"}`);
    for (const secret of [NAMES.host, NAMES.bo, ...Object.values(FIXES).flatMap((fix) => Object.values(fix))]) {
      expect(written).not.toContain(String(secret));
    }
  });
});
