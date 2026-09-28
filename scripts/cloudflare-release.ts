/**
 * The Cloudflare release file: `manhunt-cloudflare-<version>.tar.gz`, attached to
 * every GitHub release next to the GHCR image.
 *
 *   npm run build && npm run release:cloudflare
 *
 * It holds the Worker bundle and the PWA from the build that is already there,
 * plus the four operator-facing files from `deploy/release/` and a `release.env`
 * naming what this release is. Nothing in it is account-specific: the Wrangler
 * config travels as a template with `__PLACEHOLDERS__`, which the deploy script
 * fills from the deployer's own `.env` (ADR-0008).
 *
 * `scripts/release-e2e.ts` plays a real Game against the packaged file under
 * `wrangler dev` before a release publishes it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_VERSION } from '../server/game/game.ts';
import { PROTOCOL_VERSION } from '../shared/version.ts';
import { releaseVersion } from './release-version.ts';

/** Where the packaged file and its checksum are written. */
export const OUT_DIR = 'dist-release';

/** The operator-facing files shipped as they are, from `deploy/release/`. */
const OPERATOR_FILES = ['README.md', 'deploy.sh', 'wrangler.template.jsonc', '.env.example'];

/** What a release is, beyond its bundle. All four values are public. */
export interface ReleaseManifest {
  /** The release tag, e.g. `v0.2.0-rc.1` — what `/health` reports. */
  version: string;
  /** The wire protocol version the bundle speaks. */
  protocolVersion: number;
  /** The stored-snapshot version its Games carry; a rollback below it loses them. */
  snapshotVersion: number;
  /** The wrangler the release was tested with, and the one the deploy script runs. */
  wranglerVersion: string;
}

/** A path inside the repository, wherever this script is run from. */
function repoFile(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

/**
 * The wrangler version the repository is pinned to. The deploy script runs this
 * exact one, so that what deploys a release is what CI tested it with.
 */
export function pinnedWranglerVersion(): string {
  const lock = JSON.parse(readFileSync(repoFile('package-lock.json'), 'utf8')) as {
    packages: Record<string, { version: string } | undefined>;
  };
  const version = lock.packages['node_modules/wrangler']?.version;
  if (!version) throw new Error('package-lock.json has no wrangler to pin the deploy script to');
  return version;
}

export function releaseManifest(version = releaseVersion()): ReleaseManifest {
  return {
    version,
    protocolVersion: PROTOCOL_VERSION,
    snapshotVersion: SNAPSHOT_VERSION,
    wranglerVersion: pinnedWranglerVersion(),
  };
}

/** `release.env`: what `deploy.sh` sources to know which release it is deploying. */
export function releaseEnvFile(manifest: ReleaseManifest): string {
  return [
    '# What this release is. Read by deploy.sh; none of it is a secret.',
    `MANHUNT_VERSION=${manifest.version}`,
    `MANHUNT_PROTOCOL_VERSION=${manifest.protocolVersion}`,
    `MANHUNT_SNAPSHOT_VERSION=${manifest.snapshotVersion}`,
    `WRANGLER_VERSION=${manifest.wranglerVersion}`,
    '',
  ].join('\n');
}

/** Tags travel in file names, so anything a file name shouldn't hold is replaced. */
function safeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** The directory the tarball unpacks into, and the base of its name. */
export function releaseName(version: string): string {
  return `manhunt-cloudflare-${safeVersion(version)}`;
}

/**
 * Lay the release out in `stageDir`, exactly as it unpacks on the deployer's
 * machine:
 *
 *   worker/index.js   the Worker bundle Cloudflare runs        (dist-worker/)
 *   public/           the built PWA it serves                  (dist/)
 *   release.env       version, protocol, snapshot, wrangler
 *   README.md deploy.sh wrangler.template.jsonc .env.example
 */
export function stageRelease(manifest: ReleaseManifest, stageDir: string): void {
  const bundle = repoFile('dist-worker/index.js');
  const pwa = repoFile('dist/index.html');
  if (!existsSync(bundle) || !existsSync(pwa)) {
    throw new Error('no build to package — run `npm run build` first');
  }
  // The version is baked into the bundle at build time and is what `/health`
  // reports, so a release file may only ever claim the version its bundle has.
  if (!readFileSync(bundle, 'utf8').includes(JSON.stringify(manifest.version))) {
    throw new Error(
      `the bundle in dist-worker/ was not built for ${manifest.version} — run \`npm run build\` again` +
        ' (or build with MANHUNT_VERSION set to the version being packaged)',
    );
  }

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, 'worker'), { recursive: true });
  // Only the bundle: the wrangler.json Vite generates next to it names paths on
  // the build machine, and the release brings its own config template.
  cpSync(bundle, join(stageDir, 'worker/index.js'));
  cpSync(repoFile('dist'), join(stageDir, 'public'), { recursive: true });
  for (const file of OPERATOR_FILES) {
    cpSync(repoFile(`deploy/release/${file}`), join(stageDir, file));
  }
  chmodSync(join(stageDir, 'deploy.sh'), 0o755);
  writeFileSync(join(stageDir, 'release.env'), releaseEnvFile(manifest));
}

/**
 * Package the staged release into `<outDir>/<name>.tar.gz` and return its path.
 * GNU tar, as CI runs it: a stable order and no build machine's uid in the file.
 */
export function packageRelease(manifest: ReleaseManifest, outDir = OUT_DIR): string {
  const name = releaseName(manifest.version);
  const stageDir = join(outDir, name);
  const tarball = join(outDir, `${name}.tar.gz`);

  stageRelease(manifest, stageDir);
  rmSync(tarball, { force: true });
  execFileSync(
    'tar',
    ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', outDir, name],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  return tarball;
}

/** A `sha256sum --check` line for each file, named without its directory. */
export function sha256sums(files: string[]): string {
  return files
    .map((file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}\n`)
    .join('');
}

if (import.meta.main) {
  const manifest = releaseManifest();
  const tarball = packageRelease(manifest);
  const sums = join(dirname(tarball), 'SHA256SUMS');
  writeFileSync(sums, sha256sums([tarball]));

  // The release workflow attaches and attests exactly these two paths, so it is
  // told what they are rather than building the file name a second time.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `release-file=${tarball}\nsha256sums=${sums}\n`);
  }

  console.log(`\nPackaged ${manifest.version} for Cloudflare:`);
  console.log(`  ${tarball}`);
  console.log(`  ${sums}`);
  console.log(`  protocol ${manifest.protocolVersion}, snapshot ${manifest.snapshotVersion}, wrangler ${manifest.wranglerVersion}`);
}
