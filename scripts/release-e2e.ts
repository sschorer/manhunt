/**
 * The end-to-end check in front of every release, on the Cloudflare side: unpack
 * the release file, let its own deploy script render the Wrangler config, run the
 * bundle on `wrangler dev`, and play a real Game against it.
 *
 *   npm run build && npm run release:cloudflare && npm run test:release
 *   node scripts/release-e2e.ts dist-release/manhunt-cloudflare-v0.2.0.tar.gz
 *
 * This is as far as CI can go towards proving a Cloudflare deployment works:
 * nothing in GitHub has Cloudflare credentials (ADR-0008), so the check runs the
 * release's own config and bundle locally, with a stand-in account id and domain.
 * `KEEP_RELEASE=1` leaves the unpacked release behind for a look.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playGame } from './e2e/game.ts';
import { check, fail, note, step } from './e2e/report.ts';
import { releaseName } from './cloudflare-release.ts';
import { releaseVersion } from './release-version.ts';
import { PROTOCOL_VERSION } from '../shared/version.ts';

/** Stand-ins for the deployer's own settings: 32 hex characters and a hostname. */
const ACCOUNT_ID = '0'.repeat(32);
const DOMAIN = 'manhunt.e2e.invalid';
/** Proof that a rule override from `.env` reaches the Game through the template. */
const GRACE_S = '600';
/** How long `wrangler dev` may take to answer, including fetching wrangler itself. */
const READY_TIMEOUT_MS = 180_000;
/** How long it may take to stop again, before it is killed outright. */
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 1_000;

const tarball =
  process.argv[2] ?? process.env.RELEASE_FILE ?? join('dist-release', `${releaseName(releaseVersion())}.tar.gz`);

/** A free port on the loopback interface, so a parallel run can't collide. */
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** The `KEY=value` lines of a release's `release.env`. */
function readReleaseEnv(dir: string): Record<string, string> {
  const entries = readFileSync(join(dir, 'release.env'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return [key!.trim(), rest.join('=').trim()] as const;
    });
  return Object.fromEntries(entries);
}

/**
 * The pinned wrangler the release itself would be deployed with, fetched by `npx`
 * exactly as `deploy.sh` does it — never the one in this repository's
 * `node_modules`, which is not what a deployer runs.
 */
function wranglerCommand(version: string, ...args: string[]): [string, string[]] {
  return ['npx', ['--yes', `wrangler@${version}`, ...args]];
}

/** Nothing to report home about, and no interactive prompts. */
const WRANGLER_ENV = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };

/** `wrangler dev` on the unpacked release, and the handle to stop it again. */
function startWrangler(unpacked: string, version: string, port: number) {
  const log: string[] = [];
  const [command, args] = wranglerCommand(
    version,
    'dev',
    '--config',
    'wrangler.jsonc',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
  );
  const wrangler = spawn(command, args, {
    cwd: unpacked,
    // Its own process group: `wrangler dev` starts workerd underneath it, and
    // signalling the group is what stops both.
    detached: true,
    env: WRANGLER_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited: number | null = null;
  const collect = (chunk: Buffer | string) => log.push(String(chunk));
  wrangler.stdout.on('data', collect);
  wrangler.stderr.on('data', collect);
  wrangler.on('error', (error) => {
    collect(`could not run npx: ${error.message}\n`);
    exited = -1;
  });
  wrangler.on('exit', (code) => (exited = code ?? 0));

  const signal = (name: NodeJS.Signals) => {
    if (wrangler.pid === undefined) return;
    try {
      process.kill(-wrangler.pid, name);
    } catch {
      // The group is already gone; nothing left to stop.
    }
  };

  return {
    output: () => log.join(''),
    hasExited: () => exited !== null,
    /** Stop the group, and don't return until it is actually gone. */
    stop: async (): Promise<void> => {
      signal('SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (exited === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (exited === null) signal('SIGKILL');
    },
  };
}

/** Unpack the release, render its config, and play a Game against `wrangler dev`. */
async function checkRelease(workDir: string): Promise<void> {
  execFileSync('tar', ['-xzf', tarball, '-C', workDir], { stdio: ['ignore', 'inherit', 'inherit'] });
  // The directory the release unpacks into, read from the file rather than
  // assumed, so a release file built elsewhere can be checked too.
  const [entry] = readdirSync(workDir);
  check(entry !== undefined, `it unpacks into one directory, ${entry}`);
  const unpacked = join(workDir, entry!);
  check(existsSync(join(unpacked, 'worker/index.js')), 'with the Worker bundle in it');
  check(existsSync(join(unpacked, 'public/index.html')), 'and the built PWA');

  const release = readReleaseEnv(unpacked);
  check(Boolean(release.MANHUNT_VERSION), `release.env names the release: ${release.MANHUNT_VERSION}`);
  check(release.MANHUNT_PROTOCOL_VERSION === String(PROTOCOL_VERSION), `protocol ${release.MANHUNT_PROTOCOL_VERSION}`);
  check(Boolean(release.WRANGLER_VERSION), `pinned to wrangler ${release.WRANGLER_VERSION}`);
  const wranglerVersion = release.WRANGLER_VERSION!;

  step("Rendering the config with the release's own deploy script");
  writeFileSync(
    join(unpacked, '.env'),
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID}\nMANHUNT_DOMAIN=${DOMAIN}\nDISCONNECT_GRACE_S=${GRACE_S}\n`,
  );
  console.log(
    execFileSync('bash', ['deploy.sh', '--config-only'], {
      cwd: unpacked,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trimEnd(),
  );
  const config = readFileSync(join(unpacked, 'wrangler.jsonc'), 'utf8');
  check(!/__[A-Z_]+__/.test(config), 'wrangler.jsonc came out with no placeholder left in it');
  check(config.includes(`"${DOMAIN}"`), 'the Custom Domain from .env is the deployment route');
  check(config.includes(`"DISCONNECT_GRACE_S": "${GRACE_S}"`), 'and the rule override from .env is a Worker var');

  // The deploy command itself, as far as it can go without an account: it reads
  // the rendered config, the bundle and the assets, and checks the lot.
  step('Let wrangler check the deploy it would run');
  const dryRun = execFileSync(
    ...wranglerCommand(wranglerVersion, 'deploy', '--config', 'wrangler.jsonc', '--dry-run', '--outdir', join(workDir, 'dry-run')),
    { cwd: unpacked, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: WRANGLER_ENV },
  );
  check(/Total Upload/.test(dryRun), 'wrangler accepts the config, the bundle and the assets');
  check(/env\.GAMES \(GameRoom\)/.test(dryRun), 'with the GameRoom Durable Object bound to it');

  step(`Starting wrangler ${wranglerVersion} on the release's bundle`);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wrangler = startWrangler(unpacked, wranglerVersion, port);

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (wrangler.hasExited()) fail(`wrangler dev stopped before it served anything\n${wrangler.output()}`);
      const answered = await fetch(`${baseUrl}/health`).then(
        (res) => res.ok,
        () => false,
      );
      if (answered) break;
      if (Date.now() > deadline) fail(`wrangler dev never answered /health\n${wrangler.output()}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    note(`wrangler dev is serving the release on ${baseUrl}`);

    const { health } = await playGame(baseUrl);
    check(health.version === release.MANHUNT_VERSION, `the bundle reports the release version ${health.version}`);

    // Workers Static Assets serve the PWA on Cloudflare, with the app shell as the
    // fallback for every deep link the Worker doesn't own.
    step('Serve the PWA from the release, the way Cloudflare will');
    const shell = await fetch(`${baseUrl}/`);
    const html = await shell.text();
    check(shell.ok && html.includes('<div id="root">'), 'GET / answers with the app shell');
    const deepLink = await fetch(`${baseUrl}/game/ABCD`);
    check(deepLink.ok && (await deepLink.text()) === html, 'and a deep link falls back to it, as a single-page app');
  } finally {
    await wrangler.stop();
  }
}

async function main(): Promise<void> {
  if (!existsSync(tarball)) {
    fail(`no release file at ${tarball} — run \`npm run build && npm run release:cloudflare\` first`);
  }

  step(`Unpacking ${tarball}`);
  const workDir = mkdtempSync(join(tmpdir(), 'manhunt-release-'));
  try {
    await checkRelease(workDir);
  } finally {
    if (process.env.KEEP_RELEASE) {
      console.log(`\nLeft the unpacked release in ${workDir}`);
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
  console.log('\nPASS: the Cloudflare release file deploys its own config and runs a real Game.');
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
