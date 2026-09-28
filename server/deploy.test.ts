/**
 * The two deployment configurations against each other.
 *
 * The same Worker bundle runs on Cloudflare (`deploy/wrangler.jsonc`) and on
 * workerd in the Docker image (`deploy/config.capnp`). Nothing generates one from
 * the other, so this is where they are held together — a binding or a route added
 * to one and forgotten in the other fails here, long before the end-to-end check
 * in `scripts/docker-e2e.ts` would catch it against a running image.
 *
 * `config.capnp` is read as text on purpose: a drift check should assert what the
 * file plainly says, not what a parser makes of it.
 *
 * The same Worker bundle is also deployed from a release file, whose Wrangler
 * config travels as `deploy/release/wrangler.template.jsonc`. It is a third hand-
 * maintained copy of the same deployment, so it is held against the first two
 * here as well.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { WORKER_FIRST_ROUTES } from '../shared/routes.ts';

interface WranglerConfig {
  compatibility_date: string;
  compatibility_flags?: string[];
  assets: { run_worker_first: string[]; not_found_handling: string };
  vars: Record<string, string>;
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { new_sqlite_classes?: string[] }[];
}

/**
 * Set with `wrangler secret put` on Cloudflare — never Worker `vars`, because the
 * repo and the deployment configuration must not hold a private key. On the
 * Docker target they come out of the container's environment like everything else.
 */
const CLOUDFLARE_SECRETS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];

/** The Wrangler config as the release file ships it, placeholders and all. */
interface ReleaseTemplate extends WranglerConfig {
  main: string;
  no_bundle: boolean;
  workers_dev: boolean;
  preview_urls: boolean;
  observability: { enabled: boolean };
  account_id: string;
  routes: { pattern: string; custom_domain: boolean }[];
  assets: WranglerConfig['assets'] & { directory: string };
}

/** The files the Cloudflare release file ships to the deployer as they are. */
const RELEASE_FILES = ['wrangler.template.jsonc', 'deploy.sh', '.env.example', 'README.md'];

const wrangler = parse(readFileSync('deploy/wrangler.jsonc', 'utf8')) as WranglerConfig;
const templateText = readFileSync('deploy/release/wrangler.template.jsonc', 'utf8');
const template = parse(templateText) as ReleaseTemplate;
const capnp = readFileSync('deploy/config.capnp', 'utf8');
const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');

/** Every `name = "…"` given the binding kind `kind` in `config.capnp`. */
function bindingsOfKind(kind: string): string[] {
  const pattern = new RegExp(`\\(name = "([^"]+)", ${kind} = `, 'g');
  return [...capnp.matchAll(pattern)].map((match) => match[1]!);
}

function valuesOf(field: string): string[] {
  return [...capnp.matchAll(new RegExp(`${field} = "([^"]+)"`, 'g'))].map((match) => match[1]!);
}

describe('the Docker and Cloudflare configurations agree on', () => {
  it('the routes the Worker answers before the static assets', () => {
    expect(wrangler.assets.run_worker_first).toEqual([...WORKER_FIRST_ROUTES]);
  });

  it('the compatibility date, for every Worker in the image', () => {
    const dates = valuesOf('compatibilityDate');
    expect(dates.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dates)).toEqual(new Set([wrangler.compatibility_date]));
  });

  it('having no compatibility flags to keep in sync', () => {
    // Adding one to wrangler.jsonc means adding `compatibilityFlags` to both
    // Workers in config.capnp; this test is the reminder.
    expect(wrangler.compatibility_flags ?? []).toEqual([]);
    expect(capnp).not.toContain('compatibilityFlags');
  });

  it('every variable the Worker reads', () => {
    // On Cloudflare the rule overrides and `VAPID_SUBJECT` are Worker `vars`; in
    // the image, environment bindings. `PUBLIC_ORIGIN` is only ever an environment
    // binding: it exists for an operator whose proxy rewrites `Host`, which never
    // happens on Cloudflare. The VAPID keys are Cloudflare secrets.
    expect(new Set(bindingsOfKind('fromEnvironment'))).toEqual(
      new Set([...Object.keys(wrangler.vars), 'PUBLIC_ORIGIN', ...CLOUDFLARE_SECRETS]),
    );
  });

  it('the contact subject Web Push needs, without ever holding a key', () => {
    expect(wrangler.vars).toHaveProperty('VAPID_SUBJECT');
    for (const secret of CLOUDFLARE_SECRETS) expect(wrangler.vars).not.toHaveProperty(secret);
  });

  it('the Durable Object binding and its class', () => {
    const [binding] = wrangler.durable_objects.bindings;
    expect(wrangler.durable_objects.bindings).toHaveLength(1);
    expect(bindingsOfKind('durableObjectNamespace')).toEqual([binding!.name]);
    expect(valuesOf('className')).toEqual([binding!.class_name]);
  });

  it('the Durable Object storing its data in SQLite', () => {
    const sqlClasses = wrangler.migrations.flatMap((migration) => migration.new_sqlite_classes ?? []);
    expect(sqlClasses).toEqual(valuesOf('className'));
    expect(capnp).toContain('enableSql = true');
  });
});

describe('the workerd configuration', () => {
  it('keeps every Game on the volume, under a key that never changes', () => {
    expect(capnp).toContain('uniqueKey = "manhunt-gameroom"');
    expect(capnp).toContain('durableObjectStorage = (localDisk = "games")');
    expect(capnp).toMatch(/\(name = "games", disk = \(path = "\/data\/games", writable = true\)\)/);
  });

  it('denies the outbound routes that reach back into this host', () => {
    // A second line of defence under the Web Push endpoint check: NAT64 reaches
    // private IPv4 space over IPv6, and 0.0.0.0/8 is never a push service.
    const deny = /deny = \[([^\]]*)\]/.exec(capnp)?.[1] ?? '';
    expect(deny).toContain('"64:ff9b::/96"');
    expect(deny).toContain('"0.0.0.0/8"');
  });

  it('can still reach an https:// URL at all', () => {
    // Defining `internet` replaces the implicit service workerd would provide,
    // and `trustBrowserCas` defaults to false — losing this line leaves workerd
    // with no TLS network, so every Web Push send fails with "this HttpClient
    // doesn't support HTTPS".
    expect(capnp).toContain('tlsOptions = (trustBrowserCas = true)');
  });
});

describe('the image', () => {
  it('pins the workerd the test suite runs on', () => {
    // The Worker tests run on the workerd that wrangler ships; the image has to
    // run the same one, or the tests stop saying anything about it.
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version: string }>;
    };
    const pinned = /ARG WORKERD_VERSION=(\S+)/.exec(dockerfile)?.[1];

    expect(pinned).toBe(lock.packages['node_modules/workerd']?.version);
  });
});

describe('the Cloudflare release template agrees with deploy/wrangler.jsonc on', () => {
  it('the routes the Worker answers before the static assets', () => {
    expect(template.assets.run_worker_first).toEqual([...WORKER_FIRST_ROUTES]);
  });

  it('the compatibility date', () => {
    expect(template.compatibility_date).toBe(wrangler.compatibility_date);
    expect(template.compatibility_flags ?? []).toEqual(wrangler.compatibility_flags ?? []);
  });

  it('every variable the Worker reads', () => {
    // The names, not the values: a deployer's `.env` fills these in, and a blank
    // one keeps the game's default, which lives in `server/rules.ts` alone.
    expect(Object.keys(template.vars)).toEqual(Object.keys(wrangler.vars));
    for (const secret of CLOUDFLARE_SECRETS) expect(template.vars).not.toHaveProperty(secret);
  });

  it('the Durable Object binding and its class', () => {
    expect(template.durable_objects).toEqual(wrangler.durable_objects);
  });

  it('the Durable Object migrations, which are only ever added to', () => {
    expect(template.migrations).toEqual(wrangler.migrations);
  });

  it('one origin per deployment, with the PWA served by Workers Static Assets', () => {
    expect(template.workers_dev).toBe(false);
    expect(template.preview_urls).toBe(false);
    expect(template.assets.not_found_handling).toBe(wrangler.assets.not_found_handling);
    expect(template.observability.enabled).toBe(true);
  });
});

describe('the Cloudflare release file', () => {
  it('carries no account-specific data at all', () => {
    expect(template.account_id).toBe('__CLOUDFLARE_ACCOUNT_ID__');
    expect(template.routes).toEqual([{ pattern: '__MANHUNT_DOMAIN__', custom_domain: true }]);
    expect(template.vars.VAPID_SUBJECT).toBe('__VAPID_SUBJECT__');
    for (const file of RELEASE_FILES) {
      const shipped = readFileSync(`deploy/release/${file}`, 'utf8');
      // A Cloudflare account id is 32 hex characters, and a VAPID key is 43 or
      // more base64url ones. Nothing shipped may hold either.
      expect(shipped).not.toMatch(/\b[0-9a-f]{32}\b/);
      expect(shipped).not.toMatch(/[A-Za-z0-9_-]{43,}/);
    }
  });

  it('names the layout the release unpacks into', () => {
    expect(template.main).toBe('worker/index.js');
    expect(template.assets.directory).toBe('public');
    // The bundle CI ran the end-to-end check against is uploaded as it is, rather
    // than built a second time on the deployer's machine.
    expect(template.no_bundle).toBe(true);
  });

  it('has the deploy script fill every placeholder the template has', () => {
    const script = readFileSync('deploy/release/deploy.sh', 'utf8');
    const placeholders = new Set([...templateText.matchAll(/__[A-Z_]+__/g)].map(([found]) => found));
    expect(placeholders.size).toBeGreaterThan(0);
    for (const placeholder of placeholders) expect(script).toContain(placeholder);
  });

  it('documents every setting its deploy script reads', () => {
    const example = readFileSync('deploy/release/.env.example', 'utf8');
    for (const name of new Set(['CLOUDFLARE_ACCOUNT_ID', 'MANHUNT_DOMAIN', ...Object.keys(wrangler.vars)])) {
      expect(example).toContain(`${name}=`);
    }
  });
});
