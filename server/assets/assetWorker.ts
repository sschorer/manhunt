/**
 * The asset Worker: the Docker target's front door.
 *
 * On Cloudflare the platform does this job — Workers Static Assets serve the
 * built PWA and `run_worker_first` hands the Worker its own routes. workerd has
 * neither, so on Docker this Worker owns the listening socket and:
 *
 * - hands every {@link isWorkerRoute} request to the Worker unchanged, sockets
 *   included, so the `Origin` and Seat-cookie checks see what the client sent;
 * - serves the built PWA from a workerd disk service, typed by extension and
 *   with the cache headers from the same `_headers` file Cloudflare reads;
 * - falls back to the app shell, so a deep link the client routes itself works
 *   on a cold load.
 */
import { isWorkerRoute } from '../../shared/routes.ts';
import { contentTypeFor } from './contentTypes.ts';
import { headersFor, parseHeaderRules, type HeaderRule } from './headers.ts';

/** As much of a workerd service binding as this Worker needs. */
interface Service {
  fetch(request: Request): Promise<Response>;
}

export interface AssetEnv {
  /** The Worker that answers the API, the Game sockets and `/health`. */
  APP: Service;
  /** The built PWA on disk, which workerd exposes as a bare HTTP file server. */
  ASSETS: Service;
}

/** The document the client boots from, and the fallback for a path it routes itself. */
const APP_SHELL = '/index.html';

/** The cache-header file, read by this Worker and never served as an asset. */
const HEADERS_FILE = '/_headers';

/** Files Cloudflare treats as static-asset configuration rather than as assets. */
const NOT_ASSETS: ReadonlySet<string> = new Set([HEADERS_FILE, '/_redirects']);

/** What an asset with no `_headers` rule of its own is cached as. */
const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/** The parsed `_headers`, per environment: one read per workerd process. */
const headerRules = new WeakMap<AssetEnv, Promise<HeaderRule[]>>();

function rulesFor(env: AssetEnv): Promise<HeaderRule[]> {
  let rules = headerRules.get(env);
  if (!rules) {
    rules = readHeaderRules(env);
    headerRules.set(env, rules);
  }
  return rules;
}

async function readHeaderRules(env: AssetEnv): Promise<HeaderRule[]> {
  const file = await read(env, HEADERS_FILE);
  return file ? parseHeaderRules(await file.text()) : [];
}

/**
 * The asset path a request reads, or `undefined` when the request cannot name an
 * asset at all. A directory asks for its index document, while a path that tries
 * to climb out of the assets, names a dotfile, or names the header file never
 * reaches the disk — workerd's disk service refuses dotfiles too.
 */
function assetPath(pathname: string): string | undefined {
  const path = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  if (NOT_ASSETS.has(path)) return undefined;
  let segments: string[];
  try {
    segments = path.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return undefined;
  return path;
}

/** The asset a request is answered with: which file it is, and its bytes. */
interface Asset {
  readonly path: string;
  readonly file: Response;
}

/** An asset's bytes from the disk service, or `undefined` when there is no such file. */
async function read(env: AssetEnv, path: string): Promise<Response | undefined> {
  const file = await env.ASSETS.fetch(new Request(`http://assets${path}`));
  if (!file.ok) return undefined;
  // workerd answers a directory with a JSON listing and no `Content-Length`.
  return file.headers.has('Content-Length') ? file : undefined;
}

/**
 * The asset a request path is answered with: the file it names, or the app shell
 * when it names none — which is how a deep link the client routes itself works on
 * a cold load. `undefined` only when even the shell is missing from the build.
 */
async function resolve(env: AssetEnv, pathname: string): Promise<Asset | undefined> {
  const wanted = assetPath(pathname);
  if (wanted !== undefined) {
    const file = await read(env, wanted);
    if (file) return { path: wanted, file };
  }
  const shell = await read(env, APP_SHELL);
  return shell && { path: APP_SHELL, file: shell };
}

/**
 * The response for an asset. The content type follows the file that is served —
 * the app shell is HTML however deep the link was.
 *
 * The `_headers` rules are matched against the path the client asked for, as
 * Cloudflare matches them, and then against the file actually served, so the
 * served document's own headers win. Otherwise a stale `/assets/<hash>.js` would
 * fall back to the shell and be cached as immutable HTML for a year.
 */
function serve(request: Request, requested: string, asset: Asset, rules: HeaderRule[]): Response {
  const headers = new Headers({
    'Content-Type': contentTypeFor(asset.path),
    'Cache-Control': DEFAULT_CACHE_CONTROL,
  });
  for (const [name, value] of headersFor(rules, requested, asset.path)) headers.set(name, value);
  if (request.method !== 'HEAD') return new Response(asset.file.body, { status: 200, headers });
  // A bodyless answer has to carry the length itself.
  const length = asset.file.headers.get('Content-Length');
  if (length) headers.set('Content-Length', length);
  return new Response(null, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: AssetEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (isWorkerRoute(pathname)) return env.APP.fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const rules = await rulesFor(env);
    const asset = await resolve(env, pathname);
    if (!asset) return new Response('Not found', { status: 404 });
    return serve(request, pathname, asset, rules);
  },
};
