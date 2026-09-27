import { describe, expect, it } from 'vitest';
import assetWorker, { type AssetEnv } from './assetWorker.ts';

const FILES: Record<string, string> = {
  '/index.html': '<!doctype html><title>Manhunt</title>',
  '/assets/index-abc123.js': 'export default 1;',
  '/sw.js': 'self.addEventListener("install", () => {});',
  '/_headers':
    '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/index.html\n  Cache-Control: no-cache\n',
};

/** A stand-in for workerd's disk service: bytes plus `Content-Length`, nothing else. */
function disk(files: Record<string, string> = FILES) {
  const reads: string[] = [];
  return {
    reads,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      reads.push(pathname);
      const body = files[decodeURIComponent(pathname)];
      if (body === undefined) return new Response('not found', { status: 404 });
      if (pathname.endsWith('/')) {
        // A directory listing: JSON, and no `Content-Length`.
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
      });
    },
  };
}

function environment(files?: Record<string, string>): AssetEnv & { assets: ReturnType<typeof disk> } {
  const assets = disk(files);
  return {
    assets,
    ASSETS: assets,
    APP: { fetch: async (request) => new Response(`app:${new URL(request.url).pathname}`, { status: 200 }) },
  };
}

const get = (path: string, init?: RequestInit) =>
  assetWorker.fetch(new Request(`http://manhunt.example${path}`, init), environment());

describe('the asset Worker in front of the Worker', () => {
  it('hands the Worker every route it answers itself', async () => {
    for (const path of ['/health', '/api/games', '/ws/games/abc123']) {
      expect(await (await get(path)).text()).toBe(`app:${path}`);
    }
  });

  it('hands the Worker a non-GET request on its own routes', async () => {
    const res = await get('/api/games', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('app:/api/games');
  });

  it('passes the request through unchanged, so the Origin check still sees it', async () => {
    const env = environment();
    let seen: Request | undefined;
    env.APP = {
      fetch: async (request) => {
        seen = request;
        return new Response(null, { status: 204 });
      },
    };

    await assetWorker.fetch(
      new Request('http://manhunt.example/ws/games/abc123?v=1', {
        headers: { Origin: 'https://manhunt.example', Cookie: 'seat=token' },
      }),
      env,
    );

    expect(seen?.url).toBe('http://manhunt.example/ws/games/abc123?v=1');
    expect(seen?.headers.get('Origin')).toBe('https://manhunt.example');
    expect(seen?.headers.get('Cookie')).toBe('seat=token');
  });
});

describe('the asset Worker serving the PWA', () => {
  it('serves a built asset with the content type of its extension', async () => {
    const res = await get('/assets/index-abc123.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toBe(FILES['/assets/index-abc123.js']);
  });

  it('applies the cache headers from the _headers file', async () => {
    expect((await get('/assets/index-abc123.js')).headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('makes an asset no rule matches revalidate', async () => {
    expect((await get('/sw.js')).headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('reads the _headers file once, however many assets it serves', async () => {
    const env = environment();

    for (const path of ['/sw.js', '/assets/index-abc123.js', '/index.html']) {
      await assetWorker.fetch(new Request(`http://manhunt.example${path}`), env);
    }

    expect(env.assets.reads.filter((read) => read === '/_headers')).toHaveLength(1);
  });

  it('never caches the app shell under the rules of the asset that was asked for', async () => {
    // A stale hashed asset falls back to the shell; caching HTML for a year at an
    // `/assets/*` URL would pin the app to a build that no longer exists.
    const res = await get('/assets/index-gone.js');

    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('serves the app shell for a deep link the client routes itself', async () => {
    const res = await get('/join/ABCD');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(FILES['/index.html']);
  });

  it('serves the app shell at the root', async () => {
    expect(await (await get('/')).text()).toBe(FILES['/index.html']);
  });

  it('never serves the _headers file itself', async () => {
    const res = await get('/_headers');

    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(FILES['/index.html']);
  });

  it('still applies a rule written for the path that was asked for', async () => {
    // A `_headers` rule can name a client route rather than a file, as it can on
    // Cloudflare; only the shell's own headers override it.
    const env = environment({
      ...FILES,
      '/_headers': '/join/*\n  X-Robots-Tag: noindex\n  Cache-Control: immutable\n\n/index.html\n  Cache-Control: no-cache\n',
    });

    const res = await assetWorker.fetch(new Request('http://manhunt.example/join/ABCD'), env);

    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await get('/assets/index-abc123.js', { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('Content-Length')).toBe(String(FILES['/assets/index-abc123.js']!.length));
    expect(await res.text()).toBe('');
  });

  it('refuses a method the assets cannot answer', async () => {
    const res = await get('/index.html', { method: 'DELETE' });

    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('does not let an encoded traversal reach outside the assets', async () => {
    const env = environment();

    const res = await assetWorker.fetch(
      new Request('http://manhunt.example/assets/..%2f..%2fetc%2fpasswd'),
      env,
    );

    // The app shell, not a file read: the path never reached the disk.
    expect(await res.text()).toBe(FILES['/index.html']);
    expect(env.assets.reads).toEqual(['/_headers', '/index.html']);
  });

  it('says so plainly when even the app shell is missing', async () => {
    const res = await assetWorker.fetch(new Request('http://manhunt.example/'), environment({}));

    expect(res.status).toBe(404);
  });
});
