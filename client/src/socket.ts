import {
  io,
  type Socket,
  type ManagerOptions,
  type SocketOptions,
} from 'socket.io-client';

// Same-origin by default: in dev Vite proxies `/socket.io` to the game server,
// in production the server serves the client and the socket on the same origin.
// `VITE_SERVER_URL` can override the target (e.g. a separate API host).
const URL: string | undefined = import.meta.env.VITE_SERVER_URL || undefined;

/**
 * Auto-reconnect tuning for a phone on a flaky mobile signal (BACKLOG.md #24).
 * Socket.IO reconnects by default; we make the intent explicit and never give up
 * (`reconnectionAttempts: Infinity`) — a match can outlast a dead spot, and the
 * server holds a dropped player's slot for a grace period so a late reconnect can
 * still `resume`. The capped, jittered backoff keeps a herd of clients from all
 * retrying in lockstep when a shared network flaps.
 */
export const RECONNECTION_OPTIONS = {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 5_000,
  randomizationFactor: 0.5,
} as const satisfies Partial<ManagerOptions>;

export function createSocket(
  url: string | undefined = URL,
  opts: Partial<ManagerOptions & SocketOptions> = {},
): Socket {
  return io(url, { autoConnect: false, ...RECONNECTION_OPTIONS, ...opts });
}

export const socket = createSocket();
