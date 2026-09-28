import { useCallback } from 'react';
import { INBOUND_EVENTS } from '@manhunt/shared';
import type { GameConnection } from '../transport/gameConnection.ts';
import { useGpsCapture, type GpsFix, type GpsStatus } from './useGpsCapture.ts';
import { useWakeLock, type WakeLockStatus } from './useWakeLock.ts';

export interface UseTrackingOptions {
  /** Track only while true (typically: the game is active). */
  enabled: boolean;
  /** The active game and the caller's own player id; both required to emit. */
  gameId: string | null;
  playerId: string | null;
  /** The Game's own socket, which each `position_update` goes out on. */
  connection: GameConnection | null;
  /** Optional cadence override, forwarded to {@link useGpsCapture}. */
  cadenceMs?: number;
  /** Injectable geolocation source; for tests. */
  geolocation?: Geolocation;
}

export interface Tracking {
  gps: GpsStatus;
  wakeLock: WakeLockStatus;
  /** The most recent captured fix, for display. */
  last: GpsFix | null;
  error: string | null;
}

/**
 * Capture GPS and stream it to the authoritative Game for the length of a match:
 * on each throttled fix, send a `position_update` over the Game's own socket, and
 * hold a screen wake lock so the phone keeps tracking. The Game treats the
 * position as advisory input and stamps its own `recordedAt`. Tracking runs only
 * when `enabled`, both ids are known, and the socket is there.
 */
export function useTracking({
  enabled,
  gameId,
  playerId,
  connection,
  cadenceMs,
  geolocation,
}: UseTrackingOptions): Tracking {
  const active = enabled && !!gameId && !!playerId && !!connection;

  const onFix = useCallback(
    (fix: GpsFix) => {
      if (!gameId || !playerId || !connection) return;
      connection.send(INBOUND_EVENTS.positionUpdate, { gameId, playerId, lat: fix.lat, lng: fix.lng });
    },
    [gameId, playerId, connection],
  );

  const gps = useGpsCapture({ enabled: active, onFix, cadenceMs, geolocation });
  const wakeLock = useWakeLock(active);

  return { gps: gps.status, wakeLock, last: gps.last, error: gps.error };
}
