/**
 * The paths the Worker answers itself. Everything else on the origin is a static
 * asset of the PWA.
 *
 * One list, several readers: Cloudflare's `run_worker_first` in
 * `deploy/wrangler.jsonc`, and the asset Worker that fronts the Docker target
 * (`server/assets/`). `server/deploy.test.ts` keeps the Wrangler copy honest.
 */
export const WORKER_FIRST_ROUTES = ['/api/*', '/ws/*', '/health'] as const;

/** The prefix a route matches on: `/api/*` claims everything under `/api/`. */
function prefixOf(route: string): string {
  return route.endsWith('/*') ? route.slice(0, -1) : route;
}

/** Whether a request path belongs to the Worker rather than to the static assets. */
export function isWorkerRoute(pathname: string): boolean {
  return WORKER_FIRST_ROUTES.some((route) =>
    route.endsWith('/*') ? pathname.startsWith(prefixOf(route)) : pathname === route,
  );
}

/**
 * The same routes as patterns, for Workbox's `navigateFallbackDenylist` — the
 * one reader that wants regular expressions rather than a predicate. Anchored at
 * the start only, which is what a navigation denylist needs.
 */
export function workerRoutePatterns(): RegExp[] {
  return WORKER_FIRST_ROUTES.map((route) => new RegExp(`^${prefixOf(route).replace(/[.+?^${}()|[\]\\]/g, '\\$&')}`));
}
