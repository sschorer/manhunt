import { describe, expect, it } from 'vitest';
import {
  elapsedMs,
  formatClock,
  GAME_DURATION_MS,
  nextPingMs,
  PING_INTERVAL_MS,
  timeLeftMs,
} from './matchClock.ts';

const START = '2026-07-22T12:00:00.000Z';
const startMs = Date.parse(START);

describe('elapsedMs', () => {
  it('measures time since the start', () => {
    expect(elapsedMs(START, startMs + 90_000)).toBe(90_000);
  });

  it('never goes negative before the start', () => {
    expect(elapsedMs(START, startMs - 5_000)).toBe(0);
  });

  it('reads zero without a valid start time', () => {
    expect(elapsedMs(undefined, startMs)).toBe(0);
    expect(elapsedMs('not-a-date', startMs)).toBe(0);
  });
});

describe('timeLeftMs', () => {
  it('counts down from the full duration', () => {
    expect(timeLeftMs(START, startMs)).toBe(GAME_DURATION_MS);
    expect(timeLeftMs(START, startMs + 60_000)).toBe(GAME_DURATION_MS - 60_000);
  });

  it('clamps at zero once the match runs out', () => {
    expect(timeLeftMs(START, startMs + GAME_DURATION_MS + 10_000)).toBe(0);
  });
});

describe('nextPingMs', () => {
  it('is a full interval at the start and reset points', () => {
    expect(nextPingMs(START, startMs)).toBe(PING_INTERVAL_MS);
    expect(nextPingMs(START, startMs + PING_INTERVAL_MS)).toBe(PING_INTERVAL_MS);
  });

  it('counts down within an interval', () => {
    expect(nextPingMs(START, startMs + 60_000)).toBe(PING_INTERVAL_MS - 60_000);
    expect(nextPingMs(START, startMs + PING_INTERVAL_MS + 30_000)).toBe(PING_INTERVAL_MS - 30_000);
  });
});

describe('formatClock', () => {
  it('formats minutes and seconds zero-padded', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(72_000)).toBe('01:12');
    expect(formatClock(11 * 60_000 + 36_000)).toBe('11:36');
  });

  it('clamps negative durations to zero', () => {
    expect(formatClock(-5_000)).toBe('00:00');
  });

  it('does not cap the minute field past an hour', () => {
    expect(formatClock(65 * 60_000)).toBe('65:00');
  });
});
