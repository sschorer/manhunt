import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { GameConnection } from './transport/gameConnection.ts';

/**
 * How the client is currently attached to the server:
 *
 * - `connected` — the socket is up; live play flows normally.
 * - `reconnecting` — the transport dropped (a signal loss, a network flap) and
 *   Socket.IO is auto-retrying. The last-known game state is still on screen; a
 *   `resume` restores the session once the socket is back (BACKLOG.md #24).
 * - `offline` — the connection was closed in a way that won't auto-recover: we
 *   closed it deliberately, or the server forced it. No retry is in flight.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

/**
 * Socket.IO disconnect reasons that mean *no* automatic reconnect will follow:
 * the client asked to close (`io client disconnect`) or the server closed the
 * socket (`io server disconnect`). Every other reason — `transport close`,
 * `ping timeout`, `transport error` — is a drop the manager retries, which is
 * exactly the signal-loss case we want to show as "reconnecting".
 */
const TERMINAL_DISCONNECT_REASONS = new Set<string>([
  'io client disconnect',
  'io server disconnect',
]);

/**
 * Track a socket's live connection status for the UI (BACKLOG.md #24). It follows
 * `connect`/`disconnect`, mapping a recoverable drop to `reconnecting` (the
 * manager is retrying under the hood) and a deliberate/forced close to `offline`.
 * The consumer decides what to render — a status dot in the shell, a "showing
 * last-known position" banner in a live match.
 *
 * On the Worker backend it follows `connection`, the Game's own socket, instead:
 * a drop is `reconnecting` while partysocket retries, and a close with an
 * application close code is `offline`.
 */
export function useConnection(socket: Socket, connection?: GameConnection | null): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    (connection ? connection.isOpen() : socket.connected) ? 'connected' : 'reconnecting',
  );

  useEffect(() => {
    if (connection) {
      const offOpenChange = connection.onOpenChange((open) => setStatus(open ? 'connected' : 'reconnecting'));
      const offClose = connection.onClose(() => setStatus('offline'));
      return () => {
        offOpenChange();
        offClose();
      };
    }

    const onConnect = (): void => setStatus('connected');
    const onDisconnect = (reason: string): void => {
      setStatus(TERMINAL_DISCONNECT_REASONS.has(reason) ? 'offline' : 'reconnecting');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket, connection]);

  return status;
}
