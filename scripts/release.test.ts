/**
 * The Cloudflare release file's moving parts: what `release.env` says a release
 * is, and what `deploy/release/deploy.sh` does with it on the deployer's machine.
 *
 * The deploy script is tested by running it, with `npx` and `curl` stubbed on
 * `PATH`: it is the only thing that ever deploys to Cloudflare (ADR-0008), so what
 * it refuses, what it writes and what it calls are worth pinning down here rather
 * than finding out during a deploy. What it renders is checked against
 * `deploy/wrangler.jsonc` in `server/deploy.test.ts`, and the packaged file is
 * played through a real Game by `scripts/release-e2e.ts`.
 *
 * The last block here holds ADR-0008 to the workflows: nothing in GitHub deploys
 * to Cloudflare, and there is no credential in this repository that could.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { afterAll, describe, expect, it } from 'vitest';
import { pinnedWranglerVersion, releaseEnvFile, releaseName, sha256sums, type ReleaseManifest } from './cloudflare-release.ts';

const MANIFEST: ReleaseManifest = {
  version: 'v9.9.9-rc.1',
  protocolVersion: 7,
  snapshotVersion: 4,
  wranglerVersion: '4.131.1',
};

/** A valid-looking account id: 32 hex characters, as the dashboard shows it. */
const ACCOUNT_ID = 'abcdef0123456789abcdef0123456789';
const DOMAIN = 'manhunt.example.com';

const workDirs: string[] = [];

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * An unpacked release, minus the bundle and the PWA: the operator files exactly as
 * they ship, a `release.env` for `MANIFEST`, and stubs for the two commands the
 * script shells out to. Every call either script makes is appended to `calls`.
 */
function unpackedRelease(env: Record<string, string> = {}): {
  dir: string;
  run: (...args: string[]) => { status: number | null; stdout: string; stderr: string };
  calls: () => string;
  config: () => string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'manhunt-deploy-'));
  workDirs.push(dir);
  for (const file of ['deploy.sh', 'wrangler.template.jsonc', '.env.example']) {
    cpSync(`deploy/release/${file}`, join(dir, file));
  }
  writeFileSync(join(dir, 'release.env'), releaseEnvFile(MANIFEST));

  const calls = join(dir, 'calls.txt');
  mkdirSync(join(dir, 'bin'));
  for (const [name, body] of [
    ['npx', ''],
    // Whatever the test wants `/health` to answer, or nothing at all.
    ['curl', 'printf "%s" "${FAKE_HEALTH-}"\n'],
  ] as const) {
    const stub = join(dir, 'bin', name);
    writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}`);
    chmodSync(stub, 0o755);
  }

  return {
    dir,
    run: (...args: string[]) =>
      spawnSync('bash', ['deploy.sh', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ...env },
      }),
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    config: () => readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'),
  };
}

/** Write the `.env` a deployer fills in. */
function dotEnv(dir: string, settings: Record<string, string>): void {
  const lines = Object.entries(settings).map(([key, value]) => `${key}=${value}`);
  writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`);
}

const SETTINGS = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, MANHUNT_DOMAIN: DOMAIN };

describe('what a release says about itself', () => {
  it('names the version, both compatibility versions and the pinned wrangler', () => {
    expect(releaseEnvFile(MANIFEST)).toContain('MANHUNT_VERSION=v9.9.9-rc.1');
    expect(releaseEnvFile(MANIFEST)).toContain('MANHUNT_PROTOCOL_VERSION=7');
    expect(releaseEnvFile(MANIFEST)).toContain('MANHUNT_SNAPSHOT_VERSION=4');
    expect(releaseEnvFile(MANIFEST)).toContain('WRANGLER_VERSION=4.131.1');
  });

  it('is a file the deploy script can source, with a value on every line', () => {
    for (const line of releaseEnvFile(MANIFEST).trimEnd().split('\n')) {
      expect(line).toMatch(/^(#.*|[A-Z_]+=[^\s]+)$/);
    }
  });

  it('defines every variable the deploy script reads from it', () => {
    const script = readFileSync('deploy/release/deploy.sh', 'utf8');
    for (const name of ['MANHUNT_VERSION', 'MANHUNT_PROTOCOL_VERSION', 'MANHUNT_SNAPSHOT_VERSION', 'WRANGLER_VERSION']) {
      expect(script).toContain(`\${${name}}`);
    }
  });

  it('pins the wrangler the repository itself is on', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    expect(pinnedWranglerVersion()).toBe(lock.packages['node_modules/wrangler']?.version);
  });

  it('keeps the version in the file name, with nothing a file name cannot hold', () => {
    expect(releaseName('v0.2.0-rc.1')).toBe('manhunt-cloudflare-v0.2.0-rc.1');
    expect(releaseName('v0.2.0+local/build')).toBe('manhunt-cloudflare-v0.2.0-local-build');
  });

  it('checksums the published files the way `sha256sum --check` reads them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manhunt-sums-'));
    workDirs.push(dir);
    const file = join(dir, 'manhunt-cloudflare-v9.9.9.tar.gz');
    writeFileSync(file, 'not really a tarball');
    // The name only, so the check runs wherever the download sits.
    expect(sha256sums([file])).toMatch(/^[0-9a-f]{64} {2}manhunt-cloudflare-v9\.9\.9\.tar\.gz\n$/);
  });
});

describe('the deploy script renders the Wrangler config', () => {
  it('from the deployer’s own .env, leaving no placeholder behind', () => {
    const release = unpackedRelease();
    dotEnv(release.dir, { ...SETTINGS, VAPID_SUBJECT: 'mailto:ops@example.com', PING_INTERVAL_S: '60' });

    const result = release.run('--config-only');
    expect(result.status).toBe(0);

    const config = parse(release.config()) as {
      account_id: string;
      routes: { pattern: string; custom_domain: boolean }[];
      vars: Record<string, string>;
    };
    expect(release.config()).not.toMatch(/__[A-Z_]+__/);
    expect(config.account_id).toBe(ACCOUNT_ID);
    expect(config.routes).toEqual([{ pattern: DOMAIN, custom_domain: true }]);
    expect(config.vars.VAPID_SUBJECT).toBe('mailto:ops@example.com');
    expect(config.vars.PING_INTERVAL_S).toBe('60');
    // Left out of `.env`: the game's own default stays in place, and it lives in
    // the code alone.
    expect(config.vars.GAME_DURATION_S).toBe('');
  });

  it('and stops there with --config-only, deploying nothing', () => {
    const release = unpackedRelease();
    dotEnv(release.dir, SETTINGS);

    expect(release.run('--config-only').status).toBe(0);
    expect(release.calls()).toBe('');
  });

  it('but not before there is a .env to read', () => {
    const release = unpackedRelease();

    const result = release.run('--config-only');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env');
  });

  it.each([
    ['an account id that is not 32 hex characters', { CLOUDFLARE_ACCOUNT_ID: 'my-account' }, 'CLOUDFLARE_ACCOUNT_ID'],
    ['a domain that is not a hostname', { MANHUNT_DOMAIN: 'https://manhunt.example.com/' }, 'MANHUNT_DOMAIN'],
    ['a domain without a dot in it', { MANHUNT_DOMAIN: 'manhunt' }, 'MANHUNT_DOMAIN'],
    ['a push contact that is neither mailto: nor https:', { VAPID_SUBJECT: 'ops@example.com' }, 'VAPID_SUBJECT'],
    ['a rule override that is not a number of seconds', { PING_INTERVAL_S: 'fast' }, 'PING_INTERVAL_S'],
  ])('refuses %s', (_case, broken, named) => {
    const release = unpackedRelease();
    dotEnv(release.dir, { ...SETTINGS, ...broken });

    const result = release.run('--config-only');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(named);
  });
});

describe('the deploy script deploys', () => {
  it('with the pinned wrangler, labelled with the release, then reads /health', () => {
    const release = unpackedRelease({ FAKE_HEALTH: '{"ok":true,"version":"v9.9.9-rc.1","protocol":7}' });
    dotEnv(release.dir, SETTINGS);

    const result = release.run();
    expect(result.status).toBe(0);
    expect(release.calls()).toContain(`npx --yes wrangler@${MANIFEST.wranglerVersion} deploy`);
    expect(release.calls()).toContain('--config wrangler.jsonc');
    expect(release.calls()).toContain(`--message Manhunt ${MANIFEST.version}`);
    expect(release.calls()).toContain(`curl -fsS --max-time 10 https://${DOMAIN}/health`);
    // The snapshot version a rollback would have to match.
    expect(result.stdout).toContain('snapshot version 4');
  });

  it('and fails when the domain does not report this release', () => {
    const release = unpackedRelease({
      FAKE_HEALTH: '{"ok":true,"version":"v9.9.8","protocol":7}',
      HEALTH_TIMEOUT_S: '0',
    });
    dotEnv(release.dir, SETTINGS);

    const result = release.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not report v9.9.9-rc.1');
    expect(result.stderr).toContain('"version":"v9.9.8"');
  });

  it('and fails when the domain answers nothing at all', () => {
    const release = unpackedRelease({ HEALTH_TIMEOUT_S: '0' });
    dotEnv(release.dir, SETTINGS);

    const result = release.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not report v9.9.9-rc.1');
  });

  it('but never with an option it does not know', () => {
    const release = unpackedRelease();
    dotEnv(release.dir, SETTINGS);

    const result = release.run('--force');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--force');
    expect(release.calls()).toBe('');
  });
});

describe('nothing in GitHub deploys to Cloudflare', () => {
  // ADR-0008, as something that fails rather than something we remember: the repo
  // is public, and a deploy from Actions would need a Cloudflare token in it.
  const workflows = readdirSync('.github/workflows').map(
    (file) => [file, readFileSync(join('.github/workflows', file), 'utf8')] as const,
  );

  it('so no workflow deploys a Worker', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const [file, text] of workflows) {
      expect(text, file).not.toMatch(/wrangler(@[^\s]+)? (deploy|versions)/);
      expect(text, file).not.toMatch(/cloudflare\/wrangler-action/);
    }
  });

  it('and no workflow reads a Cloudflare credential', () => {
    for (const [file, text] of workflows) {
      expect(text, file).not.toMatch(/CLOUDFLARE_(API_TOKEN|API_KEY|ACCOUNT_ID|EMAIL)/);
      expect(text, file).not.toMatch(/secrets\.CLOUDFLARE/i);
    }
  });

  it('and the only secret any of them uses is the built-in GITHUB_TOKEN', () => {
    const used = new Set(workflows.flatMap(([, text]) => [...text.matchAll(/secrets\.([A-Z_]+)/g)].map(([, name]) => name)));
    expect([...used]).toEqual(['GITHUB_TOKEN']);
  });
});
