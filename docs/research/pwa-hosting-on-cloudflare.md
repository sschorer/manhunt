# Research: hosting the PWA on Cloudflare

Ticket: [#59](https://github.com/sschorer/manhunt/issues/59) (map [#53](https://github.com/sschorer/manhunt/issues/53)). Researched 2026-09-13 against Cloudflare, W3C, MDN, vite-plugin-pwa and Express docs.

## Question

Should the React/Vite PWA be served via Workers Static Assets or Cloudflare Pages on the free plan? Cover SPA fallback, same-origin serving with the API and WebSocket endpoints, caching headers, and service worker implications (Web Push, vite-plugin-pwa offline caching).

## Recommendation

Use **Workers Static Assets, in the same Worker that serves the API and forwards WebSockets to Durable Objects**. Don't use Pages.

- One Worker, one origin: `dist/` is uploaded as the Worker's assets, and `/api/*`, `/health` and the WebSocket path go to the Worker code. That matches today's single-origin Express setup, so there's no CORS, cookies stay first-party, and the service worker scope stays `/`.
- `assets.not_found_handling = "single-page-application"` replaces the Express SPA fallback.
- `assets.run_worker_first = ["/api/*", "/health", "<ws path>"]` replaces the fallback's `/api` and `/health` denylist. Keep it in sync with `navigateFallbackDenylist` in `client/vite.config.ts`.
- The default asset headers are already safe for a PWA. An optional `_headers` file can add `immutable` to the hashed `/assets/*` files.
- Docker serves the same `dist/` through Express as it does today. Its defaults (ETag, `max-age=0`) match Cloudflare's, so both targets behave the same.

Sketch (the WebSocket path depends on the realtime-transport ticket):

```jsonc
{
  "name": "manhunt",
  "main": "./server/worker.ts",
  "compatibility_date": "2026-09-13",
  "assets": {
    "directory": "./dist/",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/health", "/ws/*"]
  }
}
```

## Findings

### Cloudflare's direction: Workers over Pages

- Cloudflare blog, 2025-04-08: "Now that Workers supports both serving static assets **and** server-side rendering, you should **start with Workers**." and "Cloudflare Pages will continue to be supported, but, going forward, all of our investment, optimizations, and feature work will be dedicated to improving Workers." ([blog](https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/))
- The Pages-to-Workers migration guide says Workers has "a distinctly broader set of features available to it, (including Durable Objects, Cron Triggers, and more comprehensive Observability)". Its compatibility matrix marks Durable Objects as only partly supported on Pages (they need a separate Worker). ([migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/))
- Pages Functions: "You cannot create and deploy a Durable Object within a Pages project." The Durable Object has to live in its own Worker and be bound to Pages. ([Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/))
- Manhunt needs Durable Objects (map #53), so Pages would mean two deployments (Pages + a DO Worker). Workers Static Assets needs one. What Pages still does better (file-based Functions routing, Early Hints, custom domains outside Cloudflare zones) doesn't matter for this app.

### Free-plan limits

| Item | Workers Static Assets | Pages |
|---|---|---|
| Static asset requests | "free and unlimited" ([billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)) | free |
| Dynamic requests | 100,000/day, 10 ms CPU per request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) | Functions "count towards your quota for Workers plans" ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |
| Files | 20,000 per Worker version, 25 MiB each ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) | 20,000 per site, 25 MiB each; 500 builds/month ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)) |

- Requests matching `run_worker_first` always run the Worker and count as Worker requests. On the free plan, going over the limit returns 429s rather than falling back to static assets ([billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). So the patterns should stay narrow, limited to API, health and WebSocket paths.
- The Vite build produces a few dozen files, far below 20,000.

### Routing between assets and the Worker

- Default: "if a requested URL matches a file in the static assets directory, that file will be served — without invoking Worker code. If no matching asset is found and a Worker script is present, the request will be processed by the Worker." ([Static Assets](https://developers.cloudflare.com/workers/static-assets/))
- With `not_found_handling: "single-page-application"`, a request that matches no asset gets `/index.html` with 200. From compatibility date `2025-04-01` (`assets_navigation_prefers_asset_serving`), **navigation** requests (`Sec-Fetch-Mode: navigate`) get the SPA shell without running the Worker. Non-navigation requests such as `fetch()` still reach the Worker. ([SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/))
  - Consequence: without `run_worker_first`, opening `/health` or an `/api/...` URL directly in a browser tab returns the app shell, not the API response. This is the same issue the Express fallback avoids with its `/api` and `/health` check (`server/app.ts`).
- `run_worker_first` accepts `true` or an array of patterns, including negations (`["/api/*", "!/api/docs/*"]`). Matching paths always run the Worker first, and the `Sec-Fetch-Mode` detection is turned off for them. Array patterns need Wrangler 4.20.0+ or `@cloudflare/vite-plugin` 1.7.0+. ([SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [binding config](https://developers.cloudflare.com/workers/static-assets/binding/))
- WebSockets: the Worker gets the Upgrade request and passes it to the Durable Object with `env.X.getByName(name)` and `stub.fetch(request)`. The Hibernation WebSocket API is recommended, and "Billable Duration (GB-s) charges do not accrue during hibernation." ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)) A WebSocket handshake isn't a navigation, but list its path in `run_worker_first` anyway so the routing is explicit.
- The Worker can still read assets itself through `env.ASSETS.fetch(request)`; only the pathname is used for matching. ([binding config](https://developers.cloudflare.com/workers/static-assets/binding/))
- `html_handling` defaults to `auto-trailing-slash`, which 307-redirects `/index.html` to `/`. That's harmless for a single-page app. ([HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/))

### Headers and caching

- Default asset headers: `Cache-Control: public, max-age=0, must-revalidate` (when the request has no `Authorization` or `Range` header), an `ETag` hash for `If-None-Match` revalidation, and a `Content-Type` based on file extension. ([headers](https://developers.cloudflare.com/workers/static-assets/headers/))
- A `_headers` file in the assets directory can add, override or remove headers. Limits: 100 rules, 2,000 characters per line. It applies **only to asset responses, not Worker responses**, and the file itself isn't served. ([headers](https://developers.cloudflare.com/workers/static-assets/headers/)) The Cloudflare Vite plugin picks up `_headers` and `_redirects` from `public/`. ([Vite plugin static assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/))
- vite-plugin-pwa deployment guide: "Double check that **you do not** have caching features enabled, especially `immutable`, on locations like: `/`, `/sw.js`, `/index.html`, `/manifest.webmanifest`". ([vite-plugin-pwa deployment](https://vite-pwa-org.netlify.app/deployment/)) The Cloudflare default already follows this. The only optional tweak is long-lived caching for the hashed Vite output:

```text
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

### Service worker considerations

- A service worker script must be same-origin with the page. Its default and maximum scope is the script's own directory, unless the script is served with `Service-Worker-Allowed`. ([MDN register](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register)) vite-plugin-pwa registers `/sw.js` with scope `/` ([vite-plugin-pwa register](https://vite-pwa-org.netlify.app/guide/register-service-worker.html)). Serving `dist/` from the root of the same Worker keeps this working, and no extra header is needed.
- Browsers refetch the SW script, bypassing the HTTP cache, once a registration's last update check is more than 86,400 s old ([Service Workers spec](https://w3c.github.io/ServiceWorker/)). With `max-age=0, must-revalidate`, updates are found on every check, so `registerType: 'autoUpdate'` works as it does today.
- Workbox `navigateFallback` serves the precached `index.html` for navigations, apart from `navigateFallbackDenylist` (`/health`, `/api`, `/socket.io` today). This is the client-side copy of the edge `run_worker_first` list. If the WebSocket path changes (for example `/socket.io` to `/ws`), **update three lists together**: the Workbox denylist, `run_worker_first`, and the Docker SPA fallback check.
- Web Push is unaffected by the hosting choice. `public/push-sw.js` is copied into `dist/` and loaded by the generated worker through `importScripts`, so it's served as a normal same-origin asset. Push subscriptions are tied to the SW registration on this origin, so keeping the production origin stable (custom domain vs `*.workers.dev`) avoids re-subscribing. The server-side sending problems (`node:https`, SSRF guard) belong to the push ticket, not this one.

### Docker target

- Keep what works today: the Dockerfile copies `/app/dist` into the image, and `server/app.ts` serves it with `express.static` plus a GET/HEAD SPA fallback that skips `/api` and `/health`.
- `express.static` defaults: `etag: true`, `maxAge: 0`, `immutable: false`, `lastModified: true` ([Express API](https://expressjs.com/en/5x/api/express/)). That's the same revalidate-every-time behavior as Cloudflare's default, so offline and update behavior match on both targets.
- `_headers` is Cloudflare-only. If `/assets/*` gets `immutable` on Cloudflare, add the same rule in Express (`setHeaders` for `/assets/`) to keep the targets identical, or leave the defaults on both.
- If the Docker target ends up running the Worker code itself (for example under `workerd`, depending on the runtime ticket), the `assets` config works unchanged and the Express static layer goes away.

## Open questions surfaced

1. **Production origin:** a custom domain on a Cloudflare zone or `*.workers.dev`? This affects push subscription stability, cookies and the move to a stable domain.
2. **WebSocket path name** (`/socket.io` vs `/ws/*`): it has to be the same across the Workbox denylist, `run_worker_first` and the Docker fallback. It depends on the realtime-transport decision.
3. **Build and deploy:** whether to use `@cloudflare/vite-plugin` (one `vite build` producing the client and Worker plus a generated `wrangler.json`) or plain `wrangler deploy` pointing at `dist/`. This belongs with CI/local development in map #53.
