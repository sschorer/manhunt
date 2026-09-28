import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GameConnection } from '../transport/gameConnection.ts';
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

type FakeConnection = GameConnection & { send: ReturnType<typeof vi.fn> };

function fakeConnection(): FakeConnection {
  return { send: vi.fn() } as unknown as FakeConnection;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTracking', () => {
  it('sends a position_update over the Game connection for each captured fix', () => {
    const geo = makeFakeGeolocation();
    const connection = fakeConnection();
    renderHook(() =>
      useTracking({
        enabled: true,
        gameId: 'g1',
        playerId: 'p1',
        connection,
        geolocation: geo.geolocation,
      }),
    );

    geo.emit(52.1, 4.3);

    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(connection.send).toHaveBeenCalledWith('position_update', {
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.1,
      lng: 4.3,
    });
  });

  it('does not track when disabled', () => {
    const geo = makeFakeGeolocation();
    const connection = fakeConnection();
    renderHook(() =>
      useTracking({
        enabled: false,
        gameId: 'g1',
        playerId: 'p1',
        connection,
        geolocation: geo.geolocation,
      }),
    );

    expect(geo.geolocation.watchPosition).not.toHaveBeenCalled();
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('does not track before a player id is known', () => {
    const geo = makeFakeGeolocation();
    const connection = fakeConnection();
    renderHook(() =>
      useTracking({
        enabled: true,
        gameId: 'g1',
        playerId: null,
        connection,
        geolocation: geo.geolocation,
      }),
    );

    expect(geo.geolocation.watchPosition).not.toHaveBeenCalled();
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('does not track before the Game socket is there', () => {
    const geo = makeFakeGeolocation();
    renderHook(() =>
      useTracking({
        enabled: true,
        gameId: 'g1',
        playerId: 'p1',
        connection: null,
        geolocation: geo.geolocation,
      }),
    );

    expect(geo.geolocation.watchPosition).not.toHaveBeenCalled();
  });
});
