import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, FIXES, NAMES, placedGame } from './testing.workers.ts';

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
});
