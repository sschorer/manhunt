import { describe, expect, it } from 'vitest';
import {
  outcomeLine,
  survivorCount,
  topSurvivalMs,
  winTitle,
  type GameSummary,
} from './summary.ts';

function summary(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    gameId: 'g1',
    winner: 'hiders',
    reason: 'timer',
    startedAt: '2026-07-22T10:00:00.000Z',
    endedAt: '2026-07-22T10:25:00.000Z',
    durationMs: 1_500_000, // 25:00
    catches: [],
    hiders: [
      { playerId: 'a', name: 'Ana', caught: false, survivalMs: 1_500_000 },
      { playerId: 'b', name: 'Rui', caught: false, survivalMs: 1_500_000 },
      { playerId: 'c', name: 'Leo', caught: true, survivalMs: 700_000, caughtAt: '2026-07-22T10:11:40.000Z' },
    ],
    ...overrides,
  };
}

describe('winTitle', () => {
  it('names the winning side', () => {
    expect(winTitle('hiders')).toBe('HIDERS WIN');
    expect(winTitle('hunters')).toBe('HUNTERS WIN');
  });
});

describe('survivorCount', () => {
  it('counts hiders who were never caught', () => {
    expect(survivorCount(summary())).toBe(2);
  });

  it('is zero when every hider was caught', () => {
    expect(
      survivorCount(
        summary({
          hiders: [
            { playerId: 'a', name: 'Ana', caught: true, survivalMs: 60_000 },
            { playerId: 'b', name: 'Rui', caught: true, survivalMs: 90_000 },
          ],
        }),
      ),
    ).toBe(0);
  });
});

describe('topSurvivalMs', () => {
  it('is the longest survival across the hiders', () => {
    expect(topSurvivalMs(summary())).toBe(1_500_000);
  });

  it('is zero with no hiders', () => {
    expect(topSurvivalMs(summary({ hiders: [] }))).toBe(0);
  });
});

describe('outcomeLine', () => {
  it('reports the survivors and full time when the hiders ran out the clock', () => {
    expect(outcomeLine(summary())).toBe('2 survived the full 25:00');
  });

  it('uses the singular phrasing for a lone survivor', () => {
    expect(
      outcomeLine(
        summary({
          hiders: [
            { playerId: 'a', name: 'Ana', caught: false, survivalMs: 1_500_000 },
            { playerId: 'b', name: 'Rui', caught: true, survivalMs: 300_000 },
          ],
        }),
      ),
    ).toBe('1 hider survived the full 25:00');
  });

  it('reports the total time when the hunters caught everyone', () => {
    expect(
      outcomeLine(summary({ winner: 'hunters', reason: 'all_caught', durationMs: 754_000 })),
    ).toBe('All hiders caught in 12:34');
  });
});
