import { describe, expect, it } from 'vitest';
import {
  buildSummary,
  createOutcomeTracker,
  DEFAULT_GAME_DURATION_MS,
  winnerFor,
  type CatchRecord,
  type GameTimerApi,
} from './outcome.ts';
import type { Game, Player } from '../lobby/rooms.ts';

/** A minimal player for building a test roster. */
function player(id: string, name: string, role: 'hunter' | 'hider'): Player {
  return { id, name, role, ready: true, isHost: false };
}

/** An active game with the given roster. */
function game(id: string, players: Player[]): Game {
  return {
    id,
    roomCode: 'ABCD',
    status: 'active',
    players,
    createdAt: '2026-07-22T12:00:00.000Z',
    startedAt: '2026-07-22T12:00:00.000Z',
  };
}

/**
 * A controllable one-shot timer stand-in. Records each registered handler so a
 * test can fire the survive-the-timer timeout on demand — deterministic, no
 * `setTimeout`.
 */
function fakeTimers(): GameTimerApi & { fireAll: () => void; active: () => number; lastMs: number | undefined } {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  let lastMs: number | undefined;
  return {
    setTimeout(handler, ms) {
      lastMs = ms;
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearTimeout(handle) {
      handlers.delete(handle as number);
    },
    fireAll() {
      // Copy first: a handler that ends the game clears its own timer mid-iteration.
      for (const handler of [...handlers.values()]) handler();
    },
    active() {
      return handlers.size;
    },
    get lastMs() {
      return lastMs;
    },
  };
}

const START = '2026-07-22T12:00:00.000Z';

describe('winnerFor', () => {
  it('gives the hunters the win when the last hider is caught', () => {
    expect(winnerFor('all_caught')).toBe('hunters');
  });

  it('gives the hiders the win when the timer runs out', () => {
    expect(winnerFor('timer')).toBe('hiders');
  });
});

describe('buildSummary', () => {
  it('summarizes an all-caught game: hunters win, per-hider survival, catches listed', () => {
    const catches: CatchRecord[] = [
      { hunterId: 'h1', targetId: 'a', at: '2026-07-22T12:01:00.000Z' }, // 60 s
      { hunterId: 'h1', targetId: 'b', at: '2026-07-22T12:05:00.000Z' }, // 300 s
    ];
    const summary = buildSummary({
      gameId: 'g1',
      startedAt: START,
      endedAt: '2026-07-22T12:05:00.000Z',
      reason: 'all_caught',
      initialHiders: [
        { playerId: 'a', name: 'Ann' },
        { playerId: 'b', name: 'Bo' },
      ],
      catches,
    });

    expect(summary.winner).toBe('hunters');
    expect(summary.reason).toBe('all_caught');
    expect(summary.durationMs).toBe(300_000);
    expect(summary.catches).toEqual(catches);
    // Longest survivor first: Bo lasted 300 s, Ann 60 s.
    expect(summary.hiders).toEqual([
      { playerId: 'b', name: 'Bo', caught: true, survivalMs: 300_000, caughtAt: '2026-07-22T12:05:00.000Z' },
      { playerId: 'a', name: 'Ann', caught: true, survivalMs: 60_000, caughtAt: '2026-07-22T12:01:00.000Z' },
    ]);
  });

  it('counts a survivor as lasting until the game ended', () => {
    const summary = buildSummary({
      gameId: 'g1',
      startedAt: START,
      endedAt: '2026-07-22T12:30:00.000Z',
      reason: 'timer',
      initialHiders: [
        { playerId: 'a', name: 'Ann' },
        { playerId: 'b', name: 'Bo' },
      ],
      catches: [{ hunterId: 'h1', targetId: 'a', at: '2026-07-22T12:10:00.000Z' }],
    });

    expect(summary.winner).toBe('hiders');
    // Bo was never caught → survived the full 30 min; Ann caught at 10 min.
    const bo = summary.hiders.find((h) => h.playerId === 'b');
    expect(bo).toEqual({ playerId: 'b', name: 'Bo', caught: false, survivalMs: 1_800_000 });
    const ann = summary.hiders.find((h) => h.playerId === 'a');
    expect(ann).toMatchObject({ caught: true, survivalMs: 600_000 });
    // The survivor sorts ahead of the caught hider.
    expect(summary.hiders[0]?.playerId).toBe('b');
  });

  it('never reports a negative duration or survival time', () => {
    const summary = buildSummary({
      gameId: 'g1',
      startedAt: START,
      endedAt: START,
      reason: 'all_caught',
      initialHiders: [{ playerId: 'a', name: 'Ann' }],
      // A catch stamped (impossibly) before the start clamps to 0, not negative.
      catches: [{ hunterId: 'h1', targetId: 'a', at: '2026-07-22T11:59:00.000Z' }],
    });
    expect(summary.durationMs).toBe(0);
    expect(summary.hiders[0]?.survivalMs).toBe(0);
  });
});

describe('createOutcomeTracker', () => {
  it('reports remaining hiders and reaches zero as they are caught', () => {
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers: fakeTimers() });
    const g = game('g1', [
      player('h1', 'Hunter', 'hunter'),
      player('a', 'Ann', 'hider'),
      player('b', 'Bo', 'hider'),
    ]);
    tracker.start({ game: g, startedAt: START });
    expect(tracker.remainingHiders('g1')).toBe(2);

    tracker.recordCatch('g1', { hunterId: 'h1', targetId: 'a', at: START });
    expect(tracker.remainingHiders('g1')).toBe(1);
    tracker.recordCatch('g1', { hunterId: 'h1', targetId: 'b', at: START });
    expect(tracker.remainingHiders('g1')).toBe(0);
  });

  it('fires onExpire for a running game when the countdown elapses', () => {
    const expired: string[] = [];
    const timers = fakeTimers();
    const tracker = createOutcomeTracker({ onExpire: (id) => expired.push(id), timers });
    tracker.start({ game: game('g1', [player('a', 'Ann', 'hider')]), startedAt: START });
    expect(timers.active()).toBe(1);

    timers.fireAll();
    expect(expired).toEqual(['g1']);
  });

  it('dropPlayer removes a departed hider from the count and the summary', () => {
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers: fakeTimers() });
    const g = game('g1', [
      player('h1', 'Hunter', 'hunter'),
      player('a', 'Ann', 'hider'),
      player('b', 'Bo', 'hider'),
    ]);
    tracker.start({ game: g, startedAt: START });

    // Bo leaves mid-match: the remaining-hider count drops, so catching Ann now
    // takes the last present hider and the hunters win.
    tracker.dropPlayer('g1', 'b');
    expect(tracker.remainingHiders('g1')).toBe(1);
    tracker.recordCatch('g1', { hunterId: 'h1', targetId: 'a', at: '2026-07-22T12:01:00.000Z' });
    expect(tracker.remainingHiders('g1')).toBe(0);

    const summary = tracker.end('g1', 'all_caught', '2026-07-22T12:01:00.000Z');
    // The departed hider earns no survival line; only Ann remains.
    expect(summary?.hiders.map((h) => h.playerId)).toEqual(['a']);
  });

  it('dropPlayer of an already-caught hider leaves the count unchanged', () => {
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers: fakeTimers() });
    const g = game('g1', [
      player('h1', 'Hunter', 'hunter'),
      player('a', 'Ann', 'hider'),
      player('b', 'Bo', 'hider'),
    ]);
    tracker.start({ game: g, startedAt: START });
    tracker.recordCatch('g1', { hunterId: 'h1', targetId: 'a', at: START });
    expect(tracker.remainingHiders('g1')).toBe(1);
    // Ann (already caught, now a hunter) leaves: Bo is still the one free hider.
    tracker.dropPlayer('g1', 'a');
    expect(tracker.remainingHiders('g1')).toBe(1);
  });

  it('dropPlayer is a no-op for an unknown player or untracked game', () => {
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers: fakeTimers() });
    tracker.start({ game: game('g1', [player('a', 'Ann', 'hider')]), startedAt: START });
    expect(() => tracker.dropPlayer('g1', 'nobody')).not.toThrow();
    expect(() => tracker.dropPlayer('nope', 'a')).not.toThrow();
    expect(tracker.remainingHiders('g1')).toBe(1);
  });

  it('end() returns a summary once, then undefined (idempotent finalize)', () => {
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers: fakeTimers() });
    tracker.start({ game: game('g1', [player('a', 'Ann', 'hider')]), startedAt: START });
    tracker.recordCatch('g1', { hunterId: 'h1', targetId: 'a', at: '2026-07-22T12:02:00.000Z' });

    const summary = tracker.end('g1', 'all_caught', '2026-07-22T12:02:00.000Z');
    expect(summary?.winner).toBe('hunters');
    expect(summary?.hiders[0]).toMatchObject({ playerId: 'a', caught: true, survivalMs: 120_000 });
    // A second finalize (e.g. the timer racing the catch) yields nothing.
    expect(tracker.end('g1', 'timer', '2026-07-22T12:30:00.000Z')).toBeUndefined();
    expect(tracker.isTracking('g1')).toBe(false);
  });

  it('clears the countdown when a game ends so it cannot fire afterwards', () => {
    const expired: string[] = [];
    const timers = fakeTimers();
    const tracker = createOutcomeTracker({ onExpire: (id) => expired.push(id), timers });
    tracker.start({ game: game('g1', [player('a', 'Ann', 'hider')]), startedAt: START });
    tracker.end('g1', 'all_caught', '2026-07-22T12:02:00.000Z');
    expect(timers.active()).toBe(0);

    timers.fireAll();
    expect(expired).toEqual([]);
  });

  it('is idempotent on start: a second start does not stack timers or reset the snapshot', () => {
    const timers = fakeTimers();
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers });
    const g = game('g1', [player('a', 'Ann', 'hider')]);
    tracker.start({ game: g, startedAt: START });
    tracker.recordCatch('g1', { hunterId: 'h1', targetId: 'a', at: START });
    // A double start_game must not wipe the recorded catch or add a timer.
    tracker.start({ game: g, startedAt: START });
    expect(timers.active()).toBe(1);
    expect(tracker.remainingHiders('g1')).toBe(0);
  });

  it('treats an unknown game as having no hiders and finalizes to nothing', () => {
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers: fakeTimers() });
    expect(tracker.remainingHiders('nope')).toBe(0);
    expect(tracker.end('nope', 'timer', START)).toBeUndefined();
    expect(() => tracker.recordCatch('nope', { hunterId: 'h', targetId: 't', at: START })).not.toThrow();
  });

  it('stop() drops tracking and clears the countdown without a summary', () => {
    const expired: string[] = [];
    const timers = fakeTimers();
    const tracker = createOutcomeTracker({ onExpire: (id) => expired.push(id), timers });
    tracker.start({ game: game('g1', [player('a', 'Ann', 'hider')]), startedAt: START });
    tracker.stop('g1');
    expect(tracker.isTracking('g1')).toBe(false);
    expect(timers.active()).toBe(0);
    timers.fireAll();
    expect(expired).toEqual([]);
  });

  it('stopAll clears every tracked game', () => {
    const timers = fakeTimers();
    const tracker = createOutcomeTracker({ onExpire: () => {}, timers });
    tracker.start({ game: game('g1', [player('a', 'Ann', 'hider')]), startedAt: START });
    tracker.start({ game: game('g2', [player('b', 'Bo', 'hider')]), startedAt: START });
    tracker.stopAll();
    expect(tracker.isTracking('g1')).toBe(false);
    expect(tracker.isTracking('g2')).toBe(false);
    expect(timers.active()).toBe(0);
  });

  it('uses the default duration when none is configured and coerces a bad one', () => {
    const timersA = fakeTimers();
    createOutcomeTracker({ onExpire: () => {}, timers: timersA }).start({
      game: game('g1', [player('a', 'Ann', 'hider')]),
      startedAt: START,
    });
    expect(timersA.lastMs).toBe(DEFAULT_GAME_DURATION_MS);

    const timersB = fakeTimers();
    createOutcomeTracker({ onExpire: () => {}, durationMs: 0, timers: timersB }).start({
      game: game('g2', [player('a', 'Ann', 'hider')]),
      startedAt: START,
    });
    expect(timersB.lastMs).toBe(1);
  });
});
