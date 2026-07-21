import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useLivePositions, type LivePositions } from './useLivePositions.ts';

/** A fake socket that records handlers so a test can drive `game_state`. */
function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket = {
    emit: vi.fn(),
    on: vi.fn((event: string, cb: (payload: unknown) => void) => {
      handlers.set(event, cb);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
  };
  return {
    socket: socket as unknown as Socket & { emit: ReturnType<typeof vi.fn> },
    emitState(payload: unknown) {
      act(() => handlers.get('game_state')?.(payload));
    },
    has(event: string) {
      return handlers.has(event);
    },
  };
}

afterEach(() => {
  cleanup();
});

describe('useLivePositions', () => {
  it('subscribes to the game on mount', () => {
    const fake = fakeSocket();
    renderHook(() => useLivePositions('g1', fake.socket));
    expect(fake.socket.emit).toHaveBeenCalledWith('join', { gameId: 'g1' });
  });

  it('tracks positions from game_state for the current game', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useLivePositions('g1', fake.socket));

    const positions: LivePositions = {
      p2: { lat: 52.1, lng: 4.3, recordedAt: '2026-07-21T00:00:00.000Z' },
    };
    fake.emitState({ gameId: 'g1', positions });

    expect(result.current).toEqual(positions);
  });

  it('ignores game_state for a different game', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useLivePositions('g1', fake.socket));

    fake.emitState({
      gameId: 'other',
      positions: { p9: { lat: 1, lng: 2, recordedAt: '2026-07-21T00:00:00.000Z' } },
    });

    expect(result.current).toEqual({});
  });

  it('does not subscribe without a game id', () => {
    const fake = fakeSocket();
    renderHook(() => useLivePositions(null, fake.socket));
    expect(fake.socket.emit).not.toHaveBeenCalled();
    expect(fake.has('game_state')).toBe(false);
  });

  it('unsubscribes and clears positions on unmount', () => {
    const fake = fakeSocket();
    const { result, unmount } = renderHook(() => useLivePositions('g1', fake.socket));

    fake.emitState({
      gameId: 'g1',
      positions: { p2: { lat: 52.1, lng: 4.3, recordedAt: '2026-07-21T00:00:00.000Z' } },
    });
    expect(result.current).not.toEqual({});

    unmount();
    expect(fake.socket.off).toHaveBeenCalledWith('game_state', expect.any(Function));
  });
});
