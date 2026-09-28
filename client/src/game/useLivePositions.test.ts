import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { GameConnection } from '../transport/gameConnection.ts';
import { useLivePositions, type LivePositions } from './useLivePositions.ts';

/** A fake Game connection that records listeners so a test can drive `game_state`. */
function fakeConnection() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const connection = {
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
  } as unknown as GameConnection;
  return {
    connection,
    emitState(payload: unknown) {
      act(() => listeners.get('game_state')?.(payload));
    },
    has(event: string) {
      return listeners.has(event);
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('useLivePositions', () => {
  it('tracks positions from game_state for the current game', () => {
    const fake = fakeConnection();
    const { result } = renderHook(() => useLivePositions('g1', fake.connection));

    const positions: LivePositions = {
      p2: { lat: 52.1, lng: 4.3, recordedAt: '2026-07-21T00:00:00.000Z' },
    };
    fake.emitState({ gameId: 'g1', positions });

    expect(result.current.positions).toEqual(positions);
  });

  it('counts reveal broadcasts but leaves ordinary ticks flat', () => {
    const fake = fakeConnection();
    const { result } = renderHook(() => useLivePositions('g1', fake.connection));

    fake.emitState({ gameId: 'g1', positions: {} });
    expect(result.current.revealSeq).toBe(0);

    fake.emitState({ gameId: 'g1', positions: {}, reveal: true });
    fake.emitState({ gameId: 'g1', positions: {}, reveal: true });
    expect(result.current.revealSeq).toBe(2);
  });

  it('ignores game_state for a different game', () => {
    const fake = fakeConnection();
    const { result } = renderHook(() => useLivePositions('g1', fake.connection));

    fake.emitState({
      gameId: 'other',
      positions: { p9: { lat: 1, lng: 2, recordedAt: '2026-07-21T00:00:00.000Z' } },
    });

    expect(result.current.positions).toEqual({});
  });

  it('does not listen without a game id', () => {
    const fake = fakeConnection();
    renderHook(() => useLivePositions(null, fake.connection));
    expect(fake.has('game_state')).toBe(false);
  });

  it('does not listen before the Game socket is there', () => {
    const { result } = renderHook(() => useLivePositions('g1', null));
    expect(result.current).toEqual({ positions: {}, revealSeq: 0 });
  });

  it('unsubscribes and clears positions on unmount', () => {
    const fake = fakeConnection();
    const { result, unmount } = renderHook(() => useLivePositions('g1', fake.connection));

    fake.emitState({
      gameId: 'g1',
      positions: { p2: { lat: 52.1, lng: 4.3, recordedAt: '2026-07-21T00:00:00.000Z' } },
    });
    expect(result.current.positions).not.toEqual({});

    unmount();
    expect(fake.has('game_state')).toBe(false);
  });
});
