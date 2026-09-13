import { CLOSE_CODES, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/index.ts';
import { PROTOCOL_VERSION } from '../shared/version.ts';
import { isAllowedOrigin, readSeatToken, rejectSocket, seatCookie } from './seat.ts';

export { GameRoom } from './rooms/GameRoom.ts';

/** Join code claims to try before giving up; collisions are rare at our scale. */
const MAX_CLAIM_ATTEMPTS = 10;

const GAME_SOCKET_ROUTE = /^\/ws\/games\/([^/]+)$/;

function randomJoinCode(): string {
  // The alphabet has 32 characters, so a byte modulo 32 is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

async function createGame(request: Request, env: Cloudflare.Env): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const name = (body as { name?: unknown } | undefined)?.name;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const joinCode = randomJoinCode();
    const result = await env.GAMES.get(env.GAMES.idFromName(joinCode)).create(joinCode, name);
    if (result.ok) {
      return Response.json(
        { game: result.game, playerId: result.playerId },
        { status: 201, headers: { 'Set-Cookie': seatCookie(result.game.id, result.token) } },
      );
    }
    if (result.code === 'name_required') {
      return Response.json(result, { status: 400 });
    }
  }
  console.error(JSON.stringify({ event: 'join_code_exhausted' }));
  return Response.json({ ok: false, error: 'Could not create a Game', code: 'unavailable' }, { status: 503 });
}

function connectToGame(request: Request, env: Cloudflare.Env, gameId: string): Promise<Response> | Response {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 });
  }
  if (!isAllowedOrigin(request, env.PUBLIC_ORIGIN)) {
    console.warn(JSON.stringify({ event: 'connection_rejected', status: 403 }));
    return new Response('Forbidden', { status: 403 });
  }
  if (new URL(request.url).searchParams.get('v') !== String(PROTOCOL_VERSION)) {
    return rejectSocket(CLOSE_CODES.protocolOutdated, 'Protocol version out of date');
  }
  // The Game itself checks the token; a request without one never reaches it.
  if (!readSeatToken(request)) {
    return rejectSocket(CLOSE_CODES.seatRejected, 'Seat rejected');
  }
  let id: DurableObjectId;
  try {
    id = env.GAMES.idFromString(gameId);
  } catch {
    return rejectSocket(CLOSE_CODES.seatRejected, 'Seat rejected');
  }
  return env.GAMES.get(id).fetch(request);
}

// Worker entry. Only the routes in `run_worker_first` (deploy/wrangler.jsonc)
// reach this handler; everything else is served from the static assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, version: __MANHUNT_VERSION__, protocol: PROTOCOL_VERSION });
    }

    if (url.pathname === '/api/games' && request.method === 'POST') {
      return createGame(request, env);
    }

    const socket = GAME_SOCKET_ROUTE.exec(url.pathname);
    if (socket) return connectToGame(request, env, socket[1]!);

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
