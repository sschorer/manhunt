import { describe, expect, it } from 'vitest';
import type { GameSummary } from '../../shared/index.ts';
import { caughtNotification, gameOverNotification, revealNotification } from './notifications.ts';

const GAME_ID = 'game-1';

function summary(winner: GameSummary['winner']): GameSummary {
  return {
    gameId: GAME_ID,
    winner,
    reason: winner === 'hunters' ? 'all_caught' : 'timer',
    startedAt: '2026-09-27T10:00:00.000Z',
    endedAt: '2026-09-27T10:30:00.000Z',
    durationMs: 1_800_000,
    catches: [],
    hiders: [],
  };
}

describe('caughtNotification', () => {
  it('tells the caught Hider at once, and keeps for an hour', () => {
    const notification = caughtNotification(GAME_ID);

    expect(notification).toEqual({
      payload: {
        title: "You've been caught!",
        body: "A hunter tagged you — you're on the hunt now.",
        tag: `manhunt:${GAME_ID}:caught`,
        data: { gameId: GAME_ID, kind: 'caught' },
      },
      ttl: 3600,
      urgency: 'high',
    });
  });
});

describe('revealNotification', () => {
  it('replaces an undelivered earlier reveal of the same Game', () => {
    const notification = revealNotification(GAME_ID);

    expect(notification).toEqual({
      payload: {
        title: 'Hiders revealed',
        body: "A ping just exposed the hiders' positions — check the map.",
        tag: `manhunt:${GAME_ID}:reveal`,
        data: { gameId: GAME_ID, kind: 'reveal' },
      },
      ttl: 180,
      urgency: 'normal',
      topic: `reveal-${GAME_ID}`,
    });
  });
});

describe('gameOverNotification', () => {
  it.each([
    ['hunters', 'The hunters win — every hider was caught.'],
    ['hiders', 'The hiders win — they survived the clock.'],
  ] as const)('says how the Game went for the %s', (winner, body) => {
    const notification = gameOverNotification(summary(winner));

    expect(notification).toEqual({
      payload: {
        title: 'Game over',
        body,
        tag: `manhunt:${GAME_ID}:game_over`,
        data: {
          gameId: GAME_ID,
          kind: 'game_over',
          winner,
          reason: winner === 'hunters' ? 'all_caught' : 'timer',
        },
      },
      ttl: 3600,
      urgency: 'normal',
    });
  });
});
