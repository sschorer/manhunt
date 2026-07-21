import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useTracking } from './useTracking.ts';

/** Minimal fake geolocation that lets a test push one success fix. */
function makeFakeGeolocation() {
  let success: PositionCallback | null = null;
  const geolocation = {
    watchPosition: vi.fn((ok: PositionCallback) => {
      success = ok;
      return 1;
    }),
    clearWatch: vi.fn(),
    getCurrentPosition: vi.fn(),
  } as unknown as Geolocation;

  return {
    geolocation,
    emit(lat: number, lng: number) {
      act(() => {
        success?.({
          coords: {
            latitude: lat,
            longitude: lng,
            accuracy: 5,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
          timestamp: Date.now(),
        } as GeolocationPosition);
      });
    },
  };
}

function fakeSocket() {
  return { emit: vi.fn() } as unknown as Socket & { emit: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTracking', () => {
  it('emits a position_update for each captured fix while active', () => {
    const geo = makeFakeGeolocation();
    const socket = fakeSocket();
    renderHook(() =>
      useTracking({
        enabled: true,
        gameId: 'g1',
        playerId: 'p1',
        socket,
        geolocation: geo.geolocation,
      }),
    );

    geo.emit(52.1, 4.3);

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('position_update', {
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.1,
      lng: 4.3,
    });
  });

  it('does not track when disabled', () => {
    const geo = makeFakeGeolocation();
    const socket = fakeSocket();
    renderHook(() =>
      useTracking({
        enabled: false,
        gameId: 'g1',
        playerId: 'p1',
        socket,
        geolocation: geo.geolocation,
      }),
    );

    expect(geo.geolocation.watchPosition).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('does not track before a player id is known', () => {
    const geo = makeFakeGeolocation();
    const socket = fakeSocket();
    renderHook(() =>
      useTracking({
        enabled: true,
        gameId: 'g1',
        playerId: null,
        socket,
        geolocation: geo.geolocation,
      }),
    );

    expect(geo.geolocation.watchPosition).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
