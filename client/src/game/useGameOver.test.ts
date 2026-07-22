import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useGameOver } from './useGameOver.ts';
import type { GameSummary } from './summary.ts';

/** A fake socket that records handlers so a test can drive `game_over`. */
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
    socket: socket as unknown as Socket,
    emitOver(payload: unknown) {
      act(() => handlers.get('game_over')?.(payload));
    },
    has(event: string) {
      return handlers.has(event);
    },
  };
}

function summary(gameId = 'g1'): GameSummary {
  return {
    gameId,
    winner: 'hunters',
    reason: 'all_caught',
    startedAt: '2026-07-22T10:00:00.000Z',
    endedAt: '2026-07-22T10:12:00.000Z',
    durationMs: 720_000,
    catches: [{ hunterId: 'h', targetId: 'x', at: '2026-07-22T10:12:00.000Z' }],
    hiders: [{ playerId: 'x', name: 'Ana', caught: true, survivalMs: 720_000, caughtAt: '2026-07-22T10:12:00.000Z' }],
  };
}

afterEach(() => {
  cleanup();
});

describe('useGameOver', () => {
  it('latches the summary for the current game', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useGameOver('g1', fake.socket));

    expect(result.current).toBeNull();
    fake.emitOver({ gameId: 'g1', summary: summary() });
    expect(result.current).toEqual(summary());
  });

  it('ignores a summary for a different game', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useGameOver('g1', fake.socket));

    fake.emitOver({ gameId: 'other', summary: summary('other') });
    expect(result.current).toBeNull();
  });

  it('does not subscribe without a game id', () => {
    const fake = fakeSocket();
    const { result } = renderHook(() => useGameOver(null, fake.socket));

    expect(fake.has('game_over')).toBe(false);
    expect(result.current).toBeNull();
  });

  it('clears the summary when the game changes', () => {
    const fake = fakeSocket();
    const { result, rerender } = renderHook(({ id }) => useGameOver(id, fake.socket), {
      initialProps: { id: 'g1' as string | null },
    });

    fake.emitOver({ gameId: 'g1', summary: summary() });
    expect(result.current).not.toBeNull();

    rerender({ id: 'g2' });
    expect(result.current).toBeNull();
  });

  it('unsubscribes on unmount', () => {
    const fake = fakeSocket();
    const { unmount } = renderHook(() => useGameOver('g1', fake.socket));
    expect(fake.has('game_over')).toBe(true);
    unmount();
    expect(fake.has('game_over')).toBe(false);
  });
});
