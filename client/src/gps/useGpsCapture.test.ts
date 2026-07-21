import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_CADENCE_MS, MAX_CADENCE_MS, useGpsCapture, type GpsFix } from './useGpsCapture.ts';

/**
 * A fake `Geolocation`: `emit` feeds a success fix to the active watcher and
 * `fail` an error. Records whether a watch is active so we can assert teardown.
 */
function makeFakeGeolocation() {
  let success: PositionCallback | null = null;
  let failure: PositionErrorCallback | null = null;
  let nextId = 1;
  const cleared: number[] = [];

  const geolocation = {
    watchPosition: vi.fn((ok: PositionCallback, err?: PositionErrorCallback | null) => {
      success = ok;
      failure = err ?? null;
      return nextId++;
    }),
    clearWatch: vi.fn((id: number) => {
      cleared.push(id);
      success = null;
      failure = null;
    }),
    getCurrentPosition: vi.fn(),
  } as unknown as Geolocation;

  return {
    geolocation,
    cleared,
    emit(coords: { lat: number; lng: number; accuracy?: number; timestamp?: number }) {
      act(() => {
        success?.({
          coords: {
            latitude: coords.lat,
            longitude: coords.lng,
            accuracy: coords.accuracy ?? 5,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
          },
          timestamp: coords.timestamp ?? Date.now(),
        } as GeolocationPosition);
      });
    },
    fail(code: number, message = 'boom') {
      act(() => {
        failure?.({
          code,
          message,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        } as GeolocationPositionError);
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGpsCapture', () => {
  it('reports unsupported when there is no geolocation source', () => {
    // A Geolocation-less environment (cast avoids depending on navigator here).
    const { result } = renderHook(() =>
      useGpsCapture({ enabled: true, onFix: () => {}, geolocation: undefined }),
    );
    // jsdom exposes no navigator.geolocation, so the default source is absent.
    expect(result.current.status).toBe('unsupported');
  });

  it('stays idle until enabled', () => {
    const geo = makeFakeGeolocation();
    const onFix = vi.fn();
    const { result } = renderHook(() =>
      useGpsCapture({ enabled: false, onFix, geolocation: geo.geolocation }),
    );
    expect(result.current.status).toBe('idle');
    expect(geo.geolocation.watchPosition).not.toHaveBeenCalled();
  });

  it('emits the first fix immediately and throttles the rest to the cadence', () => {
    const geo = makeFakeGeolocation();
    const onFix = vi.fn<(fix: GpsFix) => void>();
    const { result } = renderHook(() =>
      useGpsCapture({ enabled: true, onFix, geolocation: geo.geolocation }),
    );
    expect(result.current.status).toBe('acquiring');

    // First fix goes out at once so downstream state warms up fast.
    geo.emit({ lat: 52.1, lng: 4.3 });
    expect(result.current.status).toBe('tracking');
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onFix).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 52.1, lng: 4.3 }));

    // A burst of fresh fixes inside the cadence window is coalesced into one.
    geo.emit({ lat: 52.2, lng: 4.3 });
    geo.emit({ lat: 52.3, lng: 4.3 });
    expect(onFix).toHaveBeenCalledTimes(1);

    // After a full cadence the newest held fix is flushed.
    act(() => {
      vi.advanceTimersByTime(DEFAULT_CADENCE_MS);
    });
    expect(onFix).toHaveBeenCalledTimes(2);
    expect(onFix).toHaveBeenLastCalledWith(expect.objectContaining({ lat: 52.3 }));
  });

  it('clamps an out-of-range cadence into the 5–10s band', () => {
    const geo = makeFakeGeolocation();
    const onFix = vi.fn();
    renderHook(() =>
      useGpsCapture({ enabled: true, onFix, cadenceMs: 60_000, geolocation: geo.geolocation }),
    );
    geo.emit({ lat: 1, lng: 1 });
    expect(onFix).toHaveBeenCalledTimes(1);

    // Just under the max cadence: still throttled.
    geo.emit({ lat: 2, lng: 2 });
    act(() => {
      vi.advanceTimersByTime(MAX_CADENCE_MS - 1);
    });
    expect(onFix).toHaveBeenCalledTimes(1);

    // Crossing the clamped (max) cadence releases the next fix.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onFix).toHaveBeenCalledTimes(2);
  });

  it('surfaces a denied permission and stops emitting', () => {
    const geo = makeFakeGeolocation();
    const onFix = vi.fn();
    const { result } = renderHook(() =>
      useGpsCapture({ enabled: true, onFix, geolocation: geo.geolocation }),
    );
    geo.fail(1, 'nope'); // PERMISSION_DENIED
    expect(result.current.status).toBe('denied');
    expect(result.current.error).toBe('nope');
    expect(onFix).not.toHaveBeenCalled();
  });

  it('treats a transient error as recoverable and keeps the watch', () => {
    const geo = makeFakeGeolocation();
    const onFix = vi.fn();
    const { result } = renderHook(() =>
      useGpsCapture({ enabled: true, onFix, geolocation: geo.geolocation }),
    );
    geo.fail(2, 'no signal'); // POSITION_UNAVAILABLE
    expect(result.current.status).toBe('unavailable');

    // A later fix recovers to tracking.
    geo.emit({ lat: 10, lng: 10 });
    expect(result.current.status).toBe('tracking');
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it('clears the watch on unmount', () => {
    const geo = makeFakeGeolocation();
    const { unmount } = renderHook(() =>
      useGpsCapture({ enabled: true, onFix: () => {}, geolocation: geo.geolocation }),
    );
    unmount();
    expect(geo.geolocation.clearWatch).toHaveBeenCalledTimes(1);
    expect(geo.cleared).toEqual([1]);
  });
});
