import { useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { useGpsCapture, type GpsFix, type GpsStatus } from './useGpsCapture.ts';
import { useWakeLock, type WakeLockStatus } from './useWakeLock.ts';

/**
 * The inbound event that carries one location tick (see the server's
 * `server/protocol/messages.ts`). Mirrored by hand — the client and server
 * workspaces don't share a package.
 */
const POSITION_UPDATE = 'position_update';

export interface UseTrackingOptions {
  /** Track only while true (typically: the game is active). */
  enabled: boolean;
  /** The active game and the caller's own player id; both required to emit. */
  gameId: string | null;
  playerId: string | null;
  /** The live socket to emit `position_update` on. */
  socket: Socket;
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
 * Capture GPS and stream it to the authoritative server for the length of a
 * match: on each throttled fix, emit a `position_update`, and hold a screen wake
 * lock so the phone keeps tracking. The server treats the position as advisory
 * input and stamps its own `recordedAt`. Tracking runs only when `enabled` and
 * both ids are known.
 */
export function useTracking({
  enabled,
  gameId,
  playerId,
  socket,
  cadenceMs,
  geolocation,
}: UseTrackingOptions): Tracking {
  const active = enabled && !!gameId && !!playerId;

  const onFix = useCallback(
    (fix: GpsFix) => {
      if (!gameId || !playerId) return;
      socket.emit(POSITION_UPDATE, { gameId, playerId, lat: fix.lat, lng: fix.lng });
    },
    [gameId, playerId, socket],
  );

  const gps = useGpsCapture({ enabled: active, onFix, cadenceMs, geolocation });
  const wakeLock = useWakeLock(active);

  return { gps: gps.status, wakeLock, last: gps.last, error: gps.error };
}
