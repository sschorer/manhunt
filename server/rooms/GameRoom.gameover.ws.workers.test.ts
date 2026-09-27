import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Game, GameOverEvent } from '../../shared/index.ts';
import { RETENTION_MS } from '../game/game.ts';
import {
  alarmOf,
  alarmSoon,
  connect,
  createGame,
  deletionOf,
  lobbyWhere,
  ORIGIN,
  placedGame,
  startedGame,
  stubFor,
  type Received,
} from './testing.workers.ts';

/** The Worker test config sets DISCONNECT_GRACE_S=20 and GAME_DURATION_S=600. */
const GRACE_MS = 20_000;
const GAME_DURATION_MS = 600_000;

const gameOver = (frame: Received) => frame.t === 'game_over';

/** Run the Game's alarm as if it were `at` (epoch ms). */
async function alarmAt(gameId: string, at: number): Promise<void> {
  vi.spyOn(Date, 'now').mockReturnValue(at);
  expect(await runDurableObjectAlarm(stubFor(gameId))).toBe(true);
  vi.restoreAllMocks();
}

/** Whether the Game's storage is gone: no table, no alarm. */
async function isDeleted(gameId: string): Promise<boolean> {
  return runInDurableObject(stubFor(gameId), async (_room, state) => {
    const tables = state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'game'")
      .one().n;
    return tables === 0 && (await state.storage.getAlarm()) === null;
  });
}

/** Whether a new Game can claim `game`'s Join code, as the Worker does when it creates one. */
async function claimsJoinCode(game: Game): Promise<boolean> {
  const result = await stubFor(game.id).create(game.roomCode, 'Dee');
  return result.ok && result.game.roomCode === game.roomCode;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameRoom game over', () => {
  it('tells everyone the Hunters won when the last Hider is caught, then closes every socket with 4002', async () => {
    const { host, bo, hostSocket, boSocket } = await startedGame();
    // Both stand at the same spot, well inside the Catch radius.
    const spot = { lat: 52.2, lng: 4.4 };
    hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, ...spot });
    boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, ...spot });

    await vi.waitFor(
      async () => {
        const reply = await hostSocket.request('claim_catch', {
          gameId: host.game.id,
          hunterId: host.playerId,
          targetId: bo.playerId,
        });
        expect(reply).toMatchObject({ ok: true });
      },
      { timeout: 5_000 },
    );

    const summaries = [];
    for (const socket of [hostSocket, boSocket]) {
      const { summary } = (await socket.next(gameOver)).d as GameOverEvent;
      expect(summary).toMatchObject({
        gameId: host.game.id,
        winner: 'hunters',
        reason: 'all_caught',
        catches: [{ hunterId: host.playerId, targetId: bo.playerId }],
        hiders: [{ playerId: bo.playerId, caught: true }],
      });
      expect(await socket.closed).toBe(4002);
      summaries.push(summary);
    }
    expect(summaries[1]).toEqual(summaries[0]);
    // Every Seat is kept for the summary: only the Game's deletion is left to wake for.
    expect(await alarmOf(host.game.id)).toBe(Date.parse(summaries[0]!.endedAt) + RETENTION_MS);
  });

  it('tells everyone the Hiders won when the game length elapses with a Hider free', async () => {
    const { host, bo, hostSocket, boSocket, startedAt } = await placedGame();

    await alarmAt(host.game.id, startedAt + GAME_DURATION_MS);

    for (const socket of [hostSocket, boSocket]) {
      const { summary } = (await socket.next(gameOver)).d as GameOverEvent;
      expect(summary).toMatchObject({
        winner: 'hiders',
        reason: 'timer',
        durationMs: GAME_DURATION_MS,
        hiders: [{ playerId: bo.playerId, caught: false, survivalMs: GAME_DURATION_MS }],
      });
      expect(await socket.closed).toBe(4002);
    }
  });

  it('hands a later connection the summary again, then closes it with 4002, even after an eviction', async () => {
    const { host, bo, hostSocket, boSocket, startedAt } = await placedGame();
    await alarmAt(host.game.id, startedAt + GAME_DURATION_MS);
    const { summary } = (await hostSocket.next(gameOver)).d as GameOverEvent;
    expect(await hostSocket.closed).toBe(4002);
    expect(await boSocket.closed).toBe(4002);

    for (const evict of [false, true]) {
      if (evict) await evictDurableObject(stubFor(host.game.id));
      const late = await connect(host.game.id, bo.token);
      expect((await late.next(gameOver)).d).toEqual({ gameId: host.game.id, summary });
      expect(await late.closed).toBe(4002);
    }
    // Closing those sockets started no Grace period.
    expect(await alarmOf(host.game.id)).toBe(Date.parse(summary.endedAt) + RETENTION_MS);
  });
});

describe('GameRoom retention', () => {
  it('deletes the Game when its last Seat is released, freeing its Join code', async () => {
    const host = await createGame();
    const socket = await connect(host.game.id, host.token);
    await socket.next(lobbyWhere());
    socket.ws.close(1000, 'gone');
    const releaseAt = await alarmSoon(host.game.id);
    expect(releaseAt).toBeLessThanOrEqual(Date.now() + GRACE_MS);

    await alarmAt(host.game.id, releaseAt);

    expect(await isDeleted(host.game.id)).toBe(true);
    expect(await (await connect(host.game.id, host.token)).closed).toBe(4001);
    const join = await SELF.fetch(`${ORIGIN}/api/games/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ code: host.game.roomCode, name: 'Dee' }),
    });
    expect(join.status).toBe(404);
    expect(await claimsJoinCode(host.game)).toBe(true);
  });

  it('deletes a Game that never ended 24 h after it was created, closing its sockets with 4001', async () => {
    const { host, hostSocket, boSocket } = await startedGame();
    expect(await alarmOf(host.game.id)).toBeLessThan(deletionOf(host.game));

    await alarmAt(host.game.id, deletionOf(host.game));

    expect(await hostSocket.closed).toBe(4001);
    expect(await boSocket.closed).toBe(4001);
    expect(await isDeleted(host.game.id)).toBe(true);
    expect(await claimsJoinCode(host.game)).toBe(true);
  });

  it('keeps an ended Game for 24 h after its end, then deletes it', async () => {
    const { host, hostSocket, startedAt } = await placedGame();
    const endedAt = startedAt + GAME_DURATION_MS;
    await alarmAt(host.game.id, endedAt);
    await hostSocket.next(gameOver);
    expect(await alarmOf(host.game.id)).toBe(endedAt + RETENTION_MS);

    await alarmAt(host.game.id, endedAt + RETENTION_MS);

    expect(await isDeleted(host.game.id)).toBe(true);
    expect(await claimsJoinCode(host.game)).toBe(true);
  });
});
