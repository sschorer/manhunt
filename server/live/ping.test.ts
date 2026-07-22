import { describe, expect, it } from 'vitest';
import {
  createPingScheduler,
  DEFAULT_PING_INTERVAL_MS,
  type PingTimerApi,
} from './ping.ts';

/**
 * A controllable timer stand-in. Instead of real wall-clock intervals it records
 * each registered handler so a test can fire reveals on demand and assert exactly
 * how many times each game was revealed — deterministic, no `setTimeout`.
 */
function fakeTimers(): PingTimerApi & {
  tickAll: () => void;
  active: () => number;
  lastMs: number | undefined;
} {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  let lastMs: number | undefined;
  return {
    setInterval(handler, ms) {
      lastMs = ms;
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearInterval(handle) {
      handlers.delete(handle as number);
    },
    tickAll() {
      for (const handler of handlers.values()) handler();
    },
    active() {
      return handlers.size;
    },
    get lastMs() {
      return lastMs;
    },
  };
}

describe('createPingScheduler', () => {
  it('fires a reveal for a running game on each interval tick', () => {
    const revealed: string[] = [];
    const timers = fakeTimers();
    const scheduler = createPingScheduler({
      onReveal: (gameId) => revealed.push(gameId),
      timers,
    });

    scheduler.start('game-1');
    expect(scheduler.isRunning('game-1')).toBe(true);

    timers.tickAll();
    timers.tickAll();
    expect(revealed).toEqual(['game-1', 'game-1']);
  });

  it('reveals each running game independently', () => {
    const revealed: string[] = [];
    const timers = fakeTimers();
    const scheduler = createPingScheduler({
      onReveal: (gameId) => revealed.push(gameId),
      timers,
    });

    scheduler.start('game-1');
    scheduler.start('game-2');
    expect(timers.active()).toBe(2);

    timers.tickAll();
    expect(revealed).toEqual(['game-1', 'game-2']);
  });

  it('is idempotent: starting a running game does not stack timers', () => {
    const revealed: string[] = [];
    const timers = fakeTimers();
    const scheduler = createPingScheduler({
      onReveal: (gameId) => revealed.push(gameId),
      timers,
    });

    scheduler.start('game-1');
    scheduler.start('game-1');
    expect(timers.active()).toBe(1);

    timers.tickAll();
    expect(revealed).toEqual(['game-1']);
  });

  it('stops revealing a game once stopped', () => {
    const revealed: string[] = [];
    const timers = fakeTimers();
    const scheduler = createPingScheduler({
      onReveal: (gameId) => revealed.push(gameId),
      timers,
    });

    scheduler.start('game-1');
    scheduler.stop('game-1');
    expect(scheduler.isRunning('game-1')).toBe(false);
    expect(timers.active()).toBe(0);

    timers.tickAll();
    expect(revealed).toEqual([]);
  });

  it('stop is a no-op for a game that was never started', () => {
    const timers = fakeTimers();
    const scheduler = createPingScheduler({ onReveal: () => {}, timers });
    expect(() => scheduler.stop('unknown')).not.toThrow();
    expect(scheduler.isRunning('unknown')).toBe(false);
  });

  it('stopAll clears every running game', () => {
    const revealed: string[] = [];
    const timers = fakeTimers();
    const scheduler = createPingScheduler({
      onReveal: (gameId) => revealed.push(gameId),
      timers,
    });

    scheduler.start('game-1');
    scheduler.start('game-2');
    scheduler.stopAll();
    expect(timers.active()).toBe(0);
    expect(scheduler.isRunning('game-1')).toBe(false);
    expect(scheduler.isRunning('game-2')).toBe(false);

    timers.tickAll();
    expect(revealed).toEqual([]);
  });

  it('uses the default interval when none is configured', () => {
    const timers = fakeTimers();
    const scheduler = createPingScheduler({ onReveal: () => {}, timers });
    scheduler.start('game-1');
    expect(timers.lastMs).toBe(DEFAULT_PING_INTERVAL_MS);
  });

  it('honours a configured interval and coerces a bad one to a positive integer', () => {
    const timersA = fakeTimers();
    createPingScheduler({ onReveal: () => {}, intervalMs: 5_000, timers: timersA }).start('g');
    expect(timersA.lastMs).toBe(5_000);

    // Zero/negative/fractional intervals are clamped up to a valid 1 ms minimum
    // rather than producing a nonsensical timer.
    const timersB = fakeTimers();
    createPingScheduler({ onReveal: () => {}, intervalMs: 0, timers: timersB }).start('g');
    expect(timersB.lastMs).toBe(1);
  });
});
