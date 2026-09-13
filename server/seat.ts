/**
 * The checks every Game socket passes before it reaches the Game: the `Origin`
 * header and the Seat cookie. A host module (it builds sockets with the
 * Workers `WebSocketPair`), shared by the Worker entry and `GameRoom`.
 */
import type { CloseCode } from '../shared/index.ts';

const SEAT_COOKIE = 'seat';

/** The socket path a Game's Seat cookie is scoped to. */
export function gameSocketPath(gameId: string): string {
  return `/ws/games/${gameId}`;
}

/** The `Set-Cookie` value that hands a Seat its resume token. */
export function seatCookie(gameId: string, token: string): string {
  return `${SEAT_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${gameSocketPath(gameId)}`;
}

/** The Seat token from the request's `Cookie` header, if present. */
export function readSeatToken(request: Request): string | undefined {
  for (const pair of (request.headers.get('Cookie') ?? '').split(';')) {
    const [name, ...value] = pair.trim().split('=');
    if (name === SEAT_COOKIE && value.length > 0) return value.join('=') || undefined;
  }
  return undefined;
}

/**
 * Whether the socket comes from our own page: the host in `Origin` must equal
 * the request's `Host`, or the host of `PUBLIC_ORIGIN` when it is set (behind a
 * proxy the `Host` can be internal). Only hosts are compared, so a proxy that
 * terminates TLS doesn't break the check.
 */
export function isAllowedOrigin(request: Request, publicOrigin: string | undefined): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    const expected = publicOrigin
      ? new URL(publicOrigin).host
      : (request.headers.get('Host') ?? new URL(request.url).host);
    return new URL(origin).host === expected;
  } catch {
    return false;
  }
}

/**
 * Answer an upgrade with a socket that is closed straight away, so the client
 * learns why through its close code. The socket is never handed to a Game.
 */
export function rejectSocket(code: CloseCode, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  console.warn(JSON.stringify({ event: 'connection_rejected', code }));
  return new Response(null, { status: 101, webSocket: client });
}
