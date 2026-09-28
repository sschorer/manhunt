import { useEffect, useState } from 'react';
import type { GameConnection } from './transport/gameConnection.ts';

/**
 * How the client is currently attached to its Game:
 *
 * - `connected` — the Game's socket is up; live play flows normally.
 * - `reconnecting` — the transport dropped (a signal loss, a network flap) and
 *   `partysocket` is retrying. The last-known game state is still on screen; the
 *   Game holds the Seat for its Grace period and hands back a full snapshot once
 *   the socket is up again (BACKLOG.md #24).
 * - `offline` — the socket closed with an application close code, which won't
 *   auto-recover. No retry is in flight.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

/**
 * Track the Game socket's live connection status for the UI (BACKLOG.md #24).
 * The consumer decides what to render — a "showing last-known position" banner
 * in a live match, say.
 */
export function useConnection(connection: GameConnection | null): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    connection?.isOpen() ? 'connected' : 'reconnecting',
  );

  useEffect(() => {
    if (!connection) return;

    const offOpenChange = connection.onOpenChange((open) =>
      setStatus(open ? 'connected' : 'reconnecting'),
    );
    const offClose = connection.onClose(() => setStatus('offline'));
    return () => {
      offOpenChange();
      offClose();
    };
  }, [connection]);

  return status;
}
