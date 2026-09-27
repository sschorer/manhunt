/**
 * The end-to-end check the spec puts in front of every release: play a real Game
 * against the Docker image, then replace the container and find the Game still
 * there. It is also the drift check between `deploy/config.capnp` and
 * `deploy/wrangler.jsonc` — a binding missing from one of them fails here.
 *
 *   node scripts/docker-e2e.ts                     # run the tagged image
 *   TAG=dev node scripts/docker-e2e.ts             # run a locally built tag
 *   BASE_URL=http://127.0.0.1:8080 node scripts/docker-e2e.ts    # an app already running
 *
 * With BASE_URL set nothing is started, replaced or stopped, so the Game plays
 * against whatever is there and the persistence check is skipped. KEEP_STACK
 * leaves the stack up afterwards.
 */
import { execFileSync } from 'node:child_process';
// The only WebSocket client here that can send the Seat cookie and the `Origin`
// header the upgrade is checked against; Node's own takes no headers.
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../shared/version.ts';

/** The stack as an operator runs it, with no override on top. */
const DEPLOY = ['compose', '-f', 'deploy/compose.yml'];
/** The same stack with the app published on a port, for this check to talk to. */
const COMPOSE = [...DEPLOY, '-f', 'deploy/compose.e2e.yml'];
/** How long one expected frame may take to arrive. */
const FRAME_TIMEOUT_MS = 10_000;
/** How long the container may take to report itself healthy. */
const HEALTHY_TIMEOUT_MS = 60_000;
/** How often the health state is re-read while waiting. */
const POLL_MS = 2_000;
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
/** Whether this run owns the container's lifecycle. */
const MANAGED = process.env.BASE_URL === undefined;

/** A frame the Game sent, loosely typed for matching (as in `testing.workers.ts`). */
interface Received {
  t?: string;
  re?: number;
  d?: unknown;
}

interface Seated {
  game: { id: string; roomCode: string; players: { name: string }[] };
  playerId: string;
  cookie: string;
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** What Compose would start with `COMPOSE_PROFILES` set to `profile`. */
function servicesUnder(profile: string): string[] {
  const listed = execFileSync('docker', [...DEPLOY, 'config', '--services'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, COMPOSE_PROFILES: profile },
  });
  return listed.trim().split('\n').filter(Boolean).sort();
}

function step(message: string): void {
  console.log(`\n── ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function check(condition: unknown, message: string): void {
  if (!condition) fail(message);
  note(message);
}

/** Report something that got this far without failing; there is nothing left to assert. */
function note(message: string): void {
  console.log(`   ok — ${message}`);
}

/** Seat a player over the HTTP API and keep the Seat cookie their socket needs. */
async function enter(path: string, body: unknown): Promise<Seated> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE_URL },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`POST ${path} answered ${res.status}: ${await res.text()}`);
  const cookie = /^(seat=[^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  if (!cookie) fail(`POST ${path} set no Seat cookie`);
  const seated = (await res.json()) as Omit<Seated, 'cookie'>;
  return { ...seated, cookie };
}

/** A Seat's socket, buffering everything the Game sends it. */
async function connect(seat: Seated) {
  const url = `${BASE_URL.replace(/^http/, 'ws')}/ws/games/${seat.game.id}?v=${PROTOCOL_VERSION}`;
  const ws = new WebSocket(url, { headers: { Origin: BASE_URL, Cookie: seat.cookie } });

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

const lobbyUpdate = (frame: Received) => frame.t === 'lobby_update';
const gameState = (frame: Received) => frame.t === 'game_state';

/** The health body, once the app answers it. */
async function health(): Promise<{ ok: boolean; version: string; protocol: number }> {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) fail(`GET /health answered ${res.status}`);
  return (await res.json()) as { ok: boolean; version: string; protocol: number };
}

/** Wait until Compose itself calls the app healthy, and report what it said. */
async function waitForHealthy(): Promise<string> {
  const deadline = Date.now() + HEALTHY_TIMEOUT_MS;
  for (;;) {
    const state = JSON.parse(docker(...COMPOSE, 'ps', '--format', 'json', 'app') || '{}') as {
      Health?: string;
      State?: string;
    };
    if (state.Health === 'healthy') return `${state.State}, ${state.Health}`;
    if (Date.now() > deadline) fail(`the app never became healthy (${state.State}/${state.Health})`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Plays the Game; returns whether the persistence check ran too. */
async function main(): Promise<boolean> {
  if (MANAGED) {
    step('Starting the app from deploy/compose.yml');
    docker(...COMPOSE, 'up', '-d', '--wait', 'app');
    const status = await waitForHealthy();
    // Printed so a CI log shows what `docker compose ps` says.
    console.log(docker(...COMPOSE, 'ps').trimEnd());
    note(`\`docker compose ps\` reports the app as ${status}`);
  }

  if (MANAGED) {
    // No token to dial a real tunnel with here, but which proxy each profile
    // starts is the part that can silently break.
    step('Check which proxy each profile starts');
    check(servicesUnder('caddy').join() === 'app,caddy', 'the default `caddy` profile starts Caddy in front of the app');
    check(servicesUnder('tunnel').join() === 'app,tunnel', 'the `tunnel` profile starts cloudflared instead of Caddy');
  }

  step('Health');
  const reported = await health();
  check(reported.ok, `/health answers ok (version ${reported.version})`);
  check(reported.protocol === PROTOCOL_VERSION, `the image speaks protocol ${PROTOCOL_VERSION}`);

  step('Create a Game, join it, and open both sockets');
  const host = await enter('/api/games', { name: 'Ada' });
  check(/^[A-Z2-9]{4}$/.test(host.game.roomCode), `a Game was created with Join code ${host.game.roomCode}`);
  const bo = await enter('/api/games/join', { code: host.game.roomCode, name: 'Bo' });
  check(bo.game.players.length === 2, 'Bo joined by the Join code');

  const hostSocket = await connect(host);
  const boSocket = await connect(bo);
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

  if (!MANAGED) {
    step('Skipping the persistence check: BASE_URL points at an app this run does not own');
    return false;
  }

  // Recreated rather than restarted: a restart keeps the container's own writable
  // layer, so only a new container proves the Game is on the volume — which is
  // also what an update (`pull` then `up`) does to it.
  step('Replace the container and look for the Game again');
  docker(...COMPOSE, 'up', '-d', '--force-recreate', '--wait', 'app');
  await waitForHealthy();
  const resumed = await connect(bo);
  const lobby = (await resumed.next(lobbyUpdate, "Bo's Lobby snapshot from the new container")).d as {
    game: { id: string; status: string; players: { name: string }[] };
  };
  check(lobby.game.id === host.game.id, 'the same Game is still there, on the volume');
  check(lobby.game.status === 'active', 'still running, past its Lobby');
  check(lobby.game.players.length === 2, 'with both Seats on it');

  resumed.send('position_update', { gameId: host.game.id, playerId: bo.playerId, lat: 52.2, lng: 4.4 });
  const after = (await resumed.next(
    (frame) => gameState(frame) && bo.playerId in (frame.d as { positions: object }).positions,
    'a game_state from the new container',
  ).then((frame) => frame.d)) as { positions: Record<string, { lat: number }> };
  check(after.positions[bo.playerId]?.lat === 52.2, 'and it still accepts positions');
  resumed.close();
  return true;
}

try {
  const replaced = await main();
  console.log(
    replaced
      ? '\nPASS: the image runs a real Game, and the Game survives replacing the container.'
      : '\nPASS: the app runs a real Game.',
  );
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  if (MANAGED) console.error(docker(...COMPOSE, 'logs', '--tail', '80', 'app'));
  process.exitCode = 1;
} finally {
  if (MANAGED && !process.env.KEEP_STACK) docker(...COMPOSE, 'down', '-v');
}
