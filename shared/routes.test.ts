import { describe, expect, it } from 'vitest';
import { isWorkerRoute, WORKER_FIRST_ROUTES, workerRoutePatterns } from './routes.ts';

describe('isWorkerRoute', () => {
  it('claims every path under a wildcard route', () => {
    expect(isWorkerRoute('/api/games')).toBe(true);
    expect(isWorkerRoute('/api/games/join')).toBe(true);
    expect(isWorkerRoute('/ws/games/abc123')).toBe(true);
  });

  it('claims an exact route', () => {
    expect(isWorkerRoute('/health')).toBe(true);
  });

  it('leaves the PWA and its assets to the static assets', () => {
    expect(isWorkerRoute('/')).toBe(false);
    expect(isWorkerRoute('/assets/index-abc123.js')).toBe(false);
    expect(isWorkerRoute('/sw.js')).toBe(false);
    expect(isWorkerRoute('/join/ABCD')).toBe(false);
  });

  it('does not let a lookalike path reach the Worker', () => {
    // `/api/*` covers what is *under* /api, and `/health` nothing but itself.
    expect(isWorkerRoute('/api')).toBe(false);
    expect(isWorkerRoute('/apifoo')).toBe(false);
    expect(isWorkerRoute('/healthz')).toBe(false);
    expect(isWorkerRoute('/health/live')).toBe(false);
  });
});

describe('WORKER_FIRST_ROUTES', () => {
  it('lists absolute paths, wildcards only at the end', () => {
    for (const route of WORKER_FIRST_ROUTES) {
      expect(route.startsWith('/')).toBe(true);
      expect(route.replace(/\/\*$/, '')).not.toContain('*');
    }
  });
});

describe('workerRoutePatterns', () => {
  it('matches the same paths isWorkerRoute claims', () => {
    const patterns = workerRoutePatterns();
    const matches = (pathname: string) => patterns.some((pattern) => pattern.test(pathname));

    for (const pathname of ['/api/games', '/ws/games/abc123', '/health']) {
      expect(matches(pathname)).toBe(true);
    }
    for (const pathname of ['/', '/assets/index-abc123.js', '/join/ABCD']) {
      expect(matches(pathname)).toBe(false);
    }
  });

  it('anchors at the start, because a navigation denylist needs no more', () => {
    // `/health/live` is not a Worker route, but the app shell must not shadow it
    // either — Workbox only needs to know the navigation isn't the client's.
    expect(workerRoutePatterns().some((pattern) => pattern.test('/health/live'))).toBe(true);
  });

  it('escapes anything in a route that a regular expression would read', () => {
    expect(workerRoutePatterns().some((pattern) => pattern.test('/healthx'))).toBe(true);
    expect(workerRoutePatterns().some((pattern) => pattern.test('xhealth'))).toBe(false);
  });
});
