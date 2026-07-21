import { io } from 'socket.io-client';

// Same-origin by default: in dev Vite proxies `/socket.io` to the game server,
// in production the server serves the client and the socket on the same origin.
// `VITE_SERVER_URL` can override the target (e.g. a separate API host).
const URL = import.meta.env.VITE_SERVER_URL || undefined;

export function createSocket(url = URL, opts = {}) {
  return io(url, { autoConnect: false, ...opts });
}

export const socket = createSocket();
