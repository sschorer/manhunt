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
 *
 * The Game itself lives in `scripts/e2e/game.ts`, which the Cloudflare release
 * check plays against `wrangler dev` too.
 */
import { execFileSync } from 'node:child_process';
import { connect, gameState, lobbyUpdate, playGame } from './e2e/game.ts';
import { check, fail, note, step } from './e2e/report.ts';

/** The stack as an operator runs it, with no override on top. */
const DEPLOY = ['compose', '-f', 'deploy/compose.yml'];
/** The same stack with the app published on a port, for this check to talk to. */
const COMPOSE = [...DEPLOY, '-f', 'deploy/compose.e2e.yml'];
/** How long the container may take to report itself healthy. */
const HEALTHY_TIMEOUT_MS = 60_000;
/** How often the health state is re-read while waiting. */
const POLL_MS = 2_000;
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
/** Whether this run owns the container's lifecycle. */
const MANAGED = process.env.BASE_URL === undefined;

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

    // No token to dial a real tunnel with here, but which proxy each profile
    // starts is the part that can silently break.
    step('Check which proxy each profile starts');
    check(servicesUnder('caddy').join() === 'app,caddy', 'the default `caddy` profile starts Caddy in front of the app');
    check(servicesUnder('tunnel').join() === 'app,tunnel', 'the `tunnel` profile starts cloudflared instead of Caddy');
  }

  const { host, hider, health } = await playGame(BASE_URL);
  // On a release build the version is the tag, and the image has to be the build
  // that carries it — the same version the Cloudflare release file reports.
  if (process.env.MANHUNT_VERSION) {
    check(health.version === process.env.MANHUNT_VERSION, `the image reports the expected version ${health.version}`);
  }

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
  const resumed = await connect(BASE_URL, hider);
  const lobby = (await resumed.next(lobbyUpdate, "Bo's Lobby snapshot from the new container")).d as {
    game: { id: string; status: string; players: { name: string }[] };
  };
  check(lobby.game.id === host.game.id, 'the same Game is still there, on the volume');
  check(lobby.game.status === 'active', 'still running, past its Lobby');
  check(lobby.game.players.length === 2, 'with both Seats on it');

  resumed.send('position_update', { gameId: host.game.id, playerId: hider.playerId, lat: 52.2, lng: 4.4 });
  const after = (await resumed.next(
    (frame) => gameState(frame) && hider.playerId in (frame.d as { positions: object }).positions,
    'a game_state from the new container',
  ).then((frame) => frame.d)) as { positions: Record<string, { lat: number }> };
  check(after.positions[hider.playerId]?.lat === 52.2, 'and it still accepts positions');
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
