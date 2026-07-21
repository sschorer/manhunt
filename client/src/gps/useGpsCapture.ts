import { useEffect, useRef, useState } from 'react';

/**
 * The fixed position cadence (battery vs. latency trade-off, see the README and
 * `docs/arc42.md`). `watchPosition` fires as fast as the device produces fixes;
 * we throttle emission to at most one fix per {@link DEFAULT_CADENCE_MS}, and
 * clamp any override into the documented 5–10s band.
 */
export const MIN_CADENCE_MS = 5_000;
export const MAX_CADENCE_MS = 10_000;
export const DEFAULT_CADENCE_MS = 10_000;

/** One captured location fix, normalized from a `GeolocationPosition`. */
export interface GpsFix {
  lat: number;
  lng: number;
  /** Reported accuracy in metres (`coords.accuracy`). */
  accuracy: number;
  /** Fix timestamp in epoch milliseconds (`GeolocationPosition.timestamp`). */
  at: number;
}

/**
 * Status of the capture:
 *
 * - `unsupported` — the browser has no Geolocation API.
 * - `idle` — supported, but capture is off (`enabled` is false).
 * - `acquiring` — watching, waiting for the first fix.
 * - `tracking` — receiving fixes.
 * - `denied` — the user refused location permission (terminal).
 * - `unavailable` — a position couldn't be obtained (signal/timeout); the watch
 *   keeps running and recovers to `tracking` on the next fix.
 */
export type GpsStatus = 'unsupported' | 'idle' | 'acquiring' | 'tracking' | 'denied' | 'unavailable';

export interface GpsCaptureOptions {
  /** Capture only while true; flipping it off tears down the watch. */
  enabled: boolean;
  /** Called with the latest fix on the throttled cadence. */
  onFix: (fix: GpsFix) => void;
  /** Emission cadence in ms, clamped to [{@link MIN_CADENCE_MS}, {@link MAX_CADENCE_MS}]. */
  cadenceMs?: number;
  /** Injectable geolocation source (defaults to `navigator.geolocation`); for tests. */
  geolocation?: Geolocation;
}

export interface GpsCapture {
  status: GpsStatus;
  /** The most recent fix, whether or not it has been emitted yet. */
  last: GpsFix | null;
  /** Last error message, if any (cleared on the next successful fix). */
  error: string | null;
}

function clampCadence(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_CADENCE_MS;
  return Math.min(MAX_CADENCE_MS, Math.max(MIN_CADENCE_MS, ms));
}

function defaultGeolocation(): Geolocation | null {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator
    ? navigator.geolocation
    : null;
}

/**
 * Capture the device location with `watchPosition` and hand the caller one fix
 * per fixed cadence. `watchPosition` can fire many times a second; the hook
 * keeps the newest fix and flushes it on a 5–10s heartbeat — the first fix goes
 * out immediately so downstream state warms up fast, and every fix thereafter is
 * spaced by the cadence. High accuracy is requested; a denied permission is a
 * terminal `denied` status while transient errors keep the watch alive.
 */
export function useGpsCapture({
  enabled,
  onFix,
  cadenceMs = DEFAULT_CADENCE_MS,
  geolocation,
}: GpsCaptureOptions): GpsCapture {
  const geo = geolocation ?? defaultGeolocation();
  const cadence = clampCadence(cadenceMs);
  // Event-driven state, set only from the watch callbacks; the exposed `status`
  // is derived from it during render so the effect never sets state directly.
  const [last, setLast] = useState<GpsFix | null>(null);
  const [failure, setFailure] = useState<'denied' | 'transient' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hold the latest callback in a ref so a new `onFix` identity doesn't restart
  // the watch (which would drop GPS state and re-prompt on some browsers).
  const onFixRef = useRef(onFix);
  useEffect(() => {
    onFixRef.current = onFix;
  }, [onFix]);

  useEffect(() => {
    if (!enabled || !geo) return;

    let latest: GpsFix | null = null;
    let hasEmitted = false;
    let lastEmitAt = 0;

    // Emit the newest fix, but never more often than the cadence. The first fix
    // is always sent (`hasEmitted` gate); later ones wait out the interval.
    const flush = (): void => {
      if (!latest) return;
      const now = Date.now();
      if (hasEmitted && now - lastEmitAt < cadence) return;
      hasEmitted = true;
      lastEmitAt = now;
      onFixRef.current(latest);
    };

    const onSuccess = (pos: GeolocationPosition): void => {
      latest = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: pos.timestamp,
      };
      setLast(latest);
      setFailure(null);
      setError(null);
      flush();
    };

    const onError = (err: GeolocationPositionError): void => {
      // A denied permission is terminal; POSITION_UNAVAILABLE / TIMEOUT are
      // transient and the watch keeps running (once we have a fix, they no
      // longer downgrade the derived status below).
      setFailure((f) => (f === 'denied' ? f : err.code === err.PERMISSION_DENIED ? 'denied' : 'transient'));
      setError(err.message || 'Location error');
    };

    const watchId = geo.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20_000,
    });
    const intervalId = setInterval(flush, cadence);

    return () => {
      geo.clearWatch(watchId);
      clearInterval(intervalId);
    };
  }, [enabled, geo, cadence]);

  // Derive the status from the inputs and the last observed event.
  let status: GpsStatus;
  if (!geo) status = 'unsupported';
  else if (!enabled) status = 'idle';
  else if (failure === 'denied') status = 'denied';
  else if (last) status = 'tracking';
  else if (failure === 'transient') status = 'unavailable';
  else status = 'acquiring';

  return { status, last, error };
}
