import { describe, expect, it } from 'vitest';
import { gameConfigFrom } from './rules.ts';

describe('gameConfigFrom', () => {
  it('reads the Grace period, ping interval and game length in seconds', () => {
    expect(gameConfigFrom({ DISCONNECT_GRACE_S: '45', PING_INTERVAL_S: '60', GAME_DURATION_S: '600' })).toEqual({
      graceMs: 45_000,
      pingIntervalMs: 60_000,
      gameDurationMs: 600_000,
    });
  });

  it('leaves unset or blank variables to the game defaults', () => {
    expect(gameConfigFrom({})).toEqual({});
    expect(gameConfigFrom({ DISCONNECT_GRACE_S: '', PING_INTERVAL_S: ' ' })).toEqual({});
  });

  it('leaves a null variable to the game defaults', () => {
    // A workerd `fromEnvironment` binding is null when the variable isn't set.
    expect(gameConfigFrom({ DISCONNECT_GRACE_S: null, PING_INTERVAL_S: null, GAME_DURATION_S: null })).toEqual({});
  });

  it.each(['0', '-5', 'soon'])('ignores a ping interval or game length of %o', (value) => {
    expect(gameConfigFrom({ PING_INTERVAL_S: value, GAME_DURATION_S: value })).toEqual({});
  });

  it('accepts a Grace period of 0, which releases a dropped Seat right away', () => {
    expect(gameConfigFrom({ DISCONNECT_GRACE_S: '0' })).toEqual({ graceMs: 0 });
  });

  it.each(['-1', 'soon'])('ignores a Grace period of %o', (value) => {
    expect(gameConfigFrom({ DISCONNECT_GRACE_S: value })).toEqual({});
  });
});
