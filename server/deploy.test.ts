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
 */
import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { WORKER_FIRST_ROUTES } from '../shared/routes.ts';

interface WranglerConfig {
  compatibility_date: string;
  compatibility_flags?: string[];
  assets: { run_worker_first: string[] };
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

const wrangler = parse(readFileSync('deploy/wrangler.jsonc', 'utf8')) as WranglerConfig;
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
