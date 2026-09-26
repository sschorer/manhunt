import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { BoundaryWarningEvent, PlayerEliminatedEvent } from '@manhunt/shared';
import type { GameConnection } from '../transport/gameConnection.ts';
import { useBoundaryEvents } from './useBoundaryEvents.ts';

/** A fake Game connection that hands the test the listeners it registered. */
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
    emit(name: string, event: unknown) {
      act(() => listeners.get(name)?.(event));
    },
    has: (name: string) => listeners.has(name),
  };
}

function warning(overrides: Partial<BoundaryWarningEvent> = {}): BoundaryWarningEvent {
  return {
    gameId: 'g1',
    playerId: 'p1',
    warnings: 1,
    warningsRemaining: 0,
    metersOutside: 120,
    at: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

function elimination(overrides: Partial<PlayerEliminatedEvent> = {}): PlayerEliminatedEvent {
  return {
    gameId: 'g1',
    playerId: 'p2',
    reason: 'boundary',
    at: '2026-09-13T10:00:10.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('useBoundaryEvents', () => {
  it('holds the latest warning the Game sent for this Game', () => {
    const fake = fakeConnection();
    const { result } = renderHook(() => useBoundaryEvents('g1', fake.connection));

    expect(result.current.warning).toBeNull();

    fake.emit('boundary_warning', warning());
    expect(result.current.warning).toEqual(warning());

    fake.emit('boundary_warning', warning({ warnings: 2, metersOutside: 400 }));
    expect(result.current.warning).toMatchObject({ warnings: 2, metersOutside: 400 });
  });

  it('holds the latest Elimination without losing the warning', () => {
    const fake = fakeConnection();
    const { result } = renderHook(() => useBoundaryEvents('g1', fake.connection));

    fake.emit('boundary_warning', warning());
    fake.emit('player_eliminated', elimination());

    expect(result.current).toEqual({ warning: warning(), elimination: elimination() });
  });

  it('ignores events that belong to another Game', () => {
    const fake = fakeConnection();
    const { result } = renderHook(() => useBoundaryEvents('g1', fake.connection));

    fake.emit('boundary_warning', warning({ gameId: 'g2' }));
    fake.emit('player_eliminated', elimination({ gameId: 'g2' }));

    expect(result.current).toEqual({ warning: null, elimination: null });
  });

  it('listens only while there is a Game and a connection', () => {
    const fake = fakeConnection();
    const { unmount } = renderHook(() => useBoundaryEvents('g1', fake.connection));
    expect(fake.has('boundary_warning')).toBe(true);
    expect(fake.has('player_eliminated')).toBe(true);

    unmount();
    expect(fake.has('boundary_warning')).toBe(false);
    expect(fake.has('player_eliminated')).toBe(false);

    renderHook(() => useBoundaryEvents(null, fake.connection));
    expect(fake.has('boundary_warning')).toBe(false);
  });
});
