/**
 * One real Game played over HTTP and WebSockets, against whatever is serving the
 * Worker bundle.
 *
 * Both release checks run it, so a release is judged on the same Game twice: on
 * the Docker image (`scripts/docker-e2e.ts`) and on the Cloudflare release file
 * under `wrangler dev` (`scripts/release-e2e.ts`). It talks to nothing but the
 * public HTTP API and the Game's socket, which is why the same script can drive
 * both targets.
 */
// The only WebSocket client here that can send the Seat cookie and the `Origin`
// header the upgrade is checked against; Node's own takes no headers.
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../../shared/version.ts';

/** How long one expected frame may take to arrive. */
const FRAME_TIMEOUT_MS = 10_000;

/** A frame the Game sent, loosely typed for matching (as in `testing.workers.ts`). */
export interface Received {
  t?: string;
  re?: number;
  d?: unknown;
}

/** A player seated over the HTTP API, with the cookie their socket needs. */
export interface Seated {
  game: { id: string; roomCode: string; players: { name: string }[] };
  playerId: string;
  cookie: string;
}

/** What `/health` answers. */
export interface Health {
  ok: boolean;
  version: string;
  protocol: number;
}

export function step(message: string): void {
  console.log(`\n── ${message}`);
}

export function fail(message: string): never {
  throw new Error(message);
}

export function check(condition: unknown, message: string): void {
  if (!condition) fail(message);
  note(message);
}

/** Report something that got this far without failing; there is nothing left to assert. */
export function note(message: string): void {
  console.log(`   ok — ${message}`);
}

/** The health body, once the app answers it. */
export async function health(baseUrl: string): Promise<Health> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) fail(`GET /health answered ${res.status}`);
  return (await res.json()) as Health;
}

/** Seat a player over the HTTP API and keep the Seat cookie their socket needs. */
export async function enter(baseUrl: string, path: string, body: unknown): Promise<Seated> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`POST ${path} answered ${res.status}: ${await res.text()}`);
  const cookie = /^(seat=[^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (!cookie) fail(`POST ${path} set no Seat cookie`);
  const seated = (await res.json()) as Omit<Seated, 'cookie'>;
  return { ...seated, cookie };
}

/** A Seat's socket, buffering everything the Game sends it. */
export async function connect(baseUrl: string, seat: Seated) {
  const url = `${baseUrl.replace(/^http/, 'ws')}/ws/games/${seat.game.id}?v=${PROTOCOL_VERSION}`;
  const ws = new WebSocket(url, { headers: { Origin: baseUrl, Cookie: seat.cookie } });

  const received: Received[] = [];
  let wake: (() => void) | undefined;
  ws.on('message', (data) => {
    received.push(JSON.parse(String(data)) as Received);
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('close', (code: number) => reject(new Error(`socket closed with ${code} before it opened`)));
    ws.once('error', reject);
  });

  /** Take the first buffered frame that matches, waiting up to ten seconds for it. */
  const next = async (match: (frame: Received) => boolean, what: string): Promise<Received> => {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const index = received.findIndex(match);
      if (index >= 0) return received.splice(index, 1)[0]!;
      if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 100);
      });
    }
  };

  let lastId = 0;
  return {
    next,
    close: () => ws.close(1000, 'done'),
    send: (t: string, d: unknown) => ws.send(JSON.stringify({ t, d })),
    request: async (t: string, d: unknown): Promise<Record<string, unknown>> => {
      lastId += 1;
      const id = lastId;
      ws.send(JSON.stringify({ t, id, d }));
      const reply = await next((frame) => frame.re === id, `the reply to ${t}`);
      return reply.d as Record<string, unknown>;
    },
  };
}

export const lobbyUpdate = (frame: Received) => frame.t === 'lobby_update';
export const gameState = (frame: Received) => frame.t === 'game_state';

/**
 * Create a Game, join it, start it, send a position and read the per-role views:
 * the Hider sees their own position, the Hunters don't. Returns both Seats and
 * what `/health` said, for whatever the caller wants to check on top.
 */
export async function playGame(baseUrl: string): Promise<{ host: Seated; bo: Seated; health: Health }> {
  step('Health');
  const reported = await health(baseUrl);
  check(reported.ok, `/health answers ok (version ${reported.version})`);
  check(reported.protocol === PROTOCOL_VERSION, `it speaks protocol ${PROTOCOL_VERSION}`);

  step('Create a Game, join it, and open both sockets');
  const host = await enter(baseUrl, '/api/games', { name: 'Ada' });
  check(/^[A-Z2-9]{4}$/.test(host.game.roomCode), `a Game was created with Join code ${host.game.roomCode}`);
  const bo = await enter(baseUrl, '/api/games/join', { code: host.game.roomCode, name: 'Bo' });
  check(bo.game.players.length === 2, 'Bo joined by the Join code');

  const hostSocket = await connect(baseUrl, host);
  const boSocket = await connect(baseUrl, bo);
  await hostSocket.next(lobbyUpdate, "the Host's first Lobby snapshot");
  await boSocket.next(lobbyUpdate, "Bo's first Lobby snapshot");
  note('both sockets upgraded and got their Lobby snapshot');

  step('Start the Game');
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  const started = await hostSocket.request('start_game', {});
  check(started.ok === true, 'the Host started the Game');

  step('Send a position and receive game_state');
  boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.1, lng: 4.3 });
  const view = (await boSocket.next(
    (frame) => gameState(frame) && bo.playerId in (frame.d as { positions: object }).positions,
    "Bo's own position in a game_state",
  ).then((frame) => frame.d)) as { gameId: string; positions: Record<string, { lat: number }> };
  check(view.gameId === host.game.id, 'a game_state came back naming this Game');
  check(view.positions[bo.playerId]?.lat === 52.1, "it carries the Hider's position");
  const hunterView = (await hostSocket.next(gameState, "the Hunter's game_state")).d as {
    positions: Record<string, unknown>;
  };
  check(!(bo.playerId in hunterView.positions), 'and the Hunters were not shown the Hider');

  hostSocket.close();
  boSocket.close();
  return { host, bo, health: reported };
}
