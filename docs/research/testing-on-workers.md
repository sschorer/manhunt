# Research: how do we test on Workers?

Ticket: [#58](https://github.com/sschorer/manhunt/issues/58) (map [#53](https://github.com/sschorer/manhunt/issues/53)). Researched 2026-09-13 against Cloudflare docs, npm registry metadata and the `cloudflare/workers-sdk` repo.

## Verdict

- **Unit/integration tests inside the runtime:** use **`@cloudflare/vitest-plugin`** (the renamed successor of `@cloudflare/vitest-pool-workers`). Tests run inside `workerd` via Miniflare, with `cloudflare:test` helpers for Durable Objects, alarms, D1 migrations and eviction.
- **Black-box integration + Playwright e2e:** use **`createTestHarness()` from `wrangler`**. It is now the recommended API, replacing `unstable_dev()`/`unstable_startWorker()`. It runs the *production build* locally and plugs into Playwright as a worker-scoped fixture. Plain `wrangler dev` as a Playwright `webServer` still works, but the harness adds reset, storage seeding, D1 migrations and log capture.
- **Miniflare directly:** only for advanced cases. Both tools above wrap it.
- **Vitest version:** the repo is on `vitest ^4.1.10` (4.1.10 installed), which fits the plugin's `^4.1.0` peer range. **Vitest 5.0.0 is out and not supported yet** (tracking issue [workers-sdk#15618](https://github.com/cloudflare/workers-sdk/issues/15618), open). Pin Vitest to 4.x until it lands.
- **Carry-over:** the pure domain suites (`server/live/*`, `server/lobby/*`, `server/protocol/*`, most of `server/auth/*`, `server/push/{notifier,subscriptions,vapid}`) carry over as-is. They already inject clocks and in-memory stores and don't need Node APIs. The ten Socket.IO `app.*.test.ts` suites and the two supertest suites must be **rewritten**: the transport (Socket.IO to WebSocket), the host (Express to Worker `fetch`) and the client libs (`socket.io-client`, `supertest`, `node:net` ephemeral ports) all change.

## 1. Tooling landscape (as of 2026-09)

| Tool | Status | Runs where | Use for |
|---|---|---|---|
| `@cloudflare/vitest-plugin` 1.1.8 | Current. Package created 2026-08-20 | Tests execute inside `workerd` (Miniflare) | Unit tests, DO internals, alarms, D1, bindings |
| `@cloudflare/vitest-pool-workers` 0.22.0 | Replaced by the plugin ("package API and Vitest configuration are unchanged", just rename imports/types) | same | Migrate away |
| `wrangler` `createTestHarness()` (wrangler 4.131.1 current) | Stable, recommended since 2026-07-21 | Node test runner drives local Workers running the production build | HTTP/WebSocket integration, Playwright e2e, multi-Worker |
| Miniflare API | "only relevant for advanced use cases" | Node | Custom harnesses |
| `wrangler dev` | Dev server | Local `workerd` | Local dev. Can serve as Playwright `webServer` |

Sources:

- Vitest integration overview (updated 2026-08-20): <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- Write your first test: `npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin`; "requires Vitest 4.1 or later"; needs `compatibility_date` >= 2022-10-31, ES modules format, `wrangler types`: <https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/>
- Migrate to Vitest plugin (pool-workers `^0.16.0` to plugin `^1.0.0`; outbound mocking now via `@msw/cloudflare`): <https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/>
- Testing overview (Vitest integration for units; `createTestHarness()` for integration, "compatible with Node.js test runners, Playwright, and MSW"): <https://developers.cloudflare.com/workers/testing/>
- Changelog "Run integration tests against your Worker's production build" (2026-07-21): <https://developers.cloudflare.com/changelog/post/2026-07-21-integration-test-harness/>
- Miniflare (updated 2026-07-27): <https://developers.cloudflare.com/workers/testing/miniflare/>
- npm registry: `@cloudflare/vitest-plugin@1.1.8` and `@cloudflare/vitest-pool-workers@0.22.0` both peer `vitest ^4.1.0`, `@vitest/runner ^4.1.0`, `@vitest/snapshot ^4.1.0`; `vitest@5.0.0` is latest.

Minimal config (from the docs):

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

## 2. Test APIs inside the runtime (`cloudflare:test`, `cloudflare:workers`)

From <https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/>:

- `env` (from `cloudflare:workers`): bindings from the Wrangler config. DO stubs are available as `env.GAME.get(id)`, and RPC methods can be called directly.
- `exports.default.fetch()`: integration-style calls into the Worker's `fetch`. The main Worker "runs in the same isolate/context as tests so any global mocks will apply to it too" (this replaces the older `SELF`).
- `createExecutionContext()` / `waitOnExecutionContext(ctx)`: drain `ctx.waitUntil()` promises. Useful for fire-and-forget push fan-out.
- **Durable Objects:** `runInDurableObject(stub, cb)` (same instance, direct access to `state.storage.sql`), `runDurableObjectAlarm(stub)` (runs and removes the scheduled alarm now, returns whether one existed), `evictDurableObject(stub, opts)`, `evictAllDurableObjects()`, `abortAllDurableObjects()`, `listDurableObjectIds(ns)`, `reset()`.
- **D1:** `readD1Migrations(dir)` (in config, Node side) + `applyD1Migrations(db, migrations)` (in a setup file; idempotent).

## 3. Durable Objects, alarms, WebSockets, D1

### Durable Objects and SQLite

The DO testing guide (<https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/>) covers:

- unit tests via stub RPC,
- integration via `exports.default.fetch()`,
- `runInDurableObject` to inspect private state and run `state.storage.sql.exec()` (needs `new_sqlite_classes` in the migration),
- `evictDurableObject` to test recovery from in-memory state loss while durable storage persists.

This maps directly onto the reconnect and last-known-position behaviour: evict, then assert the game rehydrates from SQLite. Recipe: <https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/durable-objects> (`alarm`, `direct-access`, `eviction`, `sqlite-in-do`, `websockets` tests).

### Alarms (our timers)

`runDurableObjectAlarm(stub)` fires an alarm immediately, so there's no waiting on wall-clock time. This is the Workers equivalent of today's injected `DisconnectTimerApi.fireAll()` pattern. The recipe `alarm.test.ts` schedules a 60 s alarm, fires it, and asserts that a second call returns `false`.

Caveats that affect clock injection:

- Vitest fake timers "do not apply to KV, R2 and cache simulators" (known issues). They are not documented as controlling DO alarm scheduling either, so drive alarms with `runDurableObjectAlarm`, not `vi.advanceTimersByTime`.
- In `workerd`, `Date.now()` "returns the time of the last I/O. It does not advance during code execution" (<https://developers.cloudflare.com/workers/reference/security-model/>). Today's pattern of injecting a clock into the tick engine and sessions is therefore still the right seam. Keep it.
- One DO alarm per object: multiple logical timers (disconnect grace per player, game end, reveal pings) must be multiplexed onto one alarm. That is a design point for the timers ticket, and it has to be testable via repeated `runDurableObjectAlarm` calls.

### WebSockets, including hibernation

- Known issue: "Using WebSockets with Durable Objects is not supported with per-file storage isolation. To work around this, run your tests with shared storage using `--max-workers=1 --no-isolate`." (<https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/>). Put WebSocket suites in a **separate Vitest project** run serially, and keep other suites parallel.
- In-runtime WebSocket test: `stub.fetch(url, { headers: { Upgrade: "websocket" } })`, take `response.webSocket`, `accept()`, `send()`, collect `message` events. The recipe `websockets.test.ts` does exactly this against a hibernatable DO (`ctx.acceptWebSocket`) and checks message ordering.
- Hibernation: `evictDurableObject` "defaults to hibernating sockets so they resume after eviction". Pass `{ webSockets: "close" }` to close them instead. This lets a test simulate hibernation plus wake-up, and a server-side drop that triggers client reconnect.
- Out of the runtime: the harness (or `wrangler dev`) exposes a real local URL, so Node tests or Playwright can open a real `WebSocket` to it. Nothing in the docs restricts this, but the docs show no WebSocket example for the harness. *Unverified:* confirm with a spike.

### D1

- In the Vitest plugin: `readD1Migrations` in `vitest.config.ts`, exposed as a test-only Miniflare binding, then `applyD1Migrations(env.DATABASE, env.TEST_MIGRATIONS)` in a `setupFiles` entry. Setup files "run outside the per-test-file storage isolation, and may be run multiple times"; the call is idempotent. Recipe: <https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/d1>.
- In the harness: `worker.applyD1Migrations("DATABASE")` reads `migrations_dir` from the Wrangler config and must be re-run after `server.reset()`. `worker.getDurableObjectStorage(binding, { name })` returns a handle for SQL seeding and inspection of a DO instance (<https://developers.cloudflare.com/workers/testing/test-harness/prepare-test-state/>).

## 4. Playwright e2e

From <https://developers.cloudflare.com/workers/testing/test-harness/integrations/> and <https://developers.cloudflare.com/workers/testing/test-harness/configure/>:

- Worker-scoped Playwright fixtures: `server` (a `createTestHarness({ workers: [{ configPath }] })`, with `listen()`/`close()`), plus an optional `network` fixture (MSW, errors on unhandled requests). `baseURL` is set from the harness server URL. An auto `reset` fixture calls `server.reset()` after each test and `server.debug()` on failure.
- The harness runs **production build output**, so the client must be built first (`vite build`) and served through Workers static assets in the same Wrangler config.
- `vars`/`secrets` can be overridden per Worker in the harness, so no separate test environment is needed for `SESSION_SECRET`, VAPID keys and similar.
- Outbound `fetch()` from the Worker is proxied through Node's `globalThis.fetch`, so Web Push delivery can be intercepted with `vi.spyOn`/MSW.
- `server.fetch()` routes relative URLs to the primary Worker. `server.getWorker(name)` targets one Worker directly. `server.getLogs()`/`clearLogs()` capture runtime logs.

Simplest alternative: keep `client/playwright.config.ts` as it is and swap `webServer.command` to `npm run build && wrangler dev --port $PORT` with a `/health` URL. That works without new fixtures but loses per-test reset and seeding. Because of `fullyParallel: true`, specs would then share one local DO/D1 state, which is fine today since each spec creates its own room.

## 5. What carries over vs what is rewritten

Repo state checked: 42 server test files; no `vi.useFakeTimers` in server tests (timers and clocks are injected through `createServer` options); client tests use jsdom and fake timers (unaffected).

| Suite | Fate | Why |
|---|---|---|
| `server/live/*.test.ts` (tick, positions, boundary, catch, outcome, ping, broadcaster) | **Carry over**, run under plain Node Vitest or the plugin | Pure logic with injected clock/stores. Only the store implementations behind them change |
| `server/lobby/rooms.test.ts`, `server/protocol/messages.test.ts` | **Carry over** | Pure; message shapes are kept |
| `server/auth/{session,store,bootstrap}.test.ts` | **Mostly carry over** | Re-target the store at a D1/SQLite implementation |
| `server/auth/password.test.ts` | **Revisit** | scrypt N=2^15 is a known CPU hazard; tests follow the new KDF decision |
| `server/push/{notifier,subscriptions,vapid}.test.ts` | **Carry over** (vapid depends on Web Crypto choice) | Sender is injected |
| `server/push/ssrf.test.ts` | **Rewrite or drop** | Relies on `node:dns`/`node:https` |
| `server/auth/postgres.test.ts`, `server/redis/client.test.ts`, `server/db/migrate.test.ts` | **Delete / replace** | Postgres/Redis go away; replaced by D1/DO-SQLite migration tests |
| `server/app.*.test.ts` (10 Socket.IO suites) + `app.auth.test.ts`, `app.test.ts` (supertest) | **Rewrite** | Boot Express on an ephemeral `node:net` port and speak Socket.IO. Rewrite the behaviour specs against the DO via `runInDurableObject` / `stub.fetch` WebSocket upgrade (serial project), or against the harness with a real WebSocket client. The scenarios (catch, win, filter, reconnect grace) stay the same; the drivers change |
| `client/e2e/*.spec.ts` | **Carry over**, config changes | Only `webServer`/fixtures change, plus the client transport swap |

Parity note for the Docker target: the carry-over suites are runtime-agnostic and prove shared logic once. Proving that the Docker host behaves the same needs either the same e2e run against the Docker image, or a runtime that is itself `workerd` on Docker. That choice belongs to the runtime/adapter ticket.

## 6. Known limitations to plan around

From <https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/> (updated 2026-08-20):

- Coverage: V8 native coverage is not supported; use Istanbul.
- Dynamic `import()` does not work inside `export default` handlers or DO event handlers under test; use static imports.
- DO WebSockets require `--max-workers=1 --no-isolate` (see above).
- Per-file storage isolation: await all storage ops, use `using` for non-primitive RPC results, and consume every response body.
- Missing `ctx.exports` entries for wildcard or virtual re-exports; fix with `additionalExports`.
- CJS/ESM resolution errors: use `deps.optimizer.ssr.include`.
- `globalSetup` runs in Node, not `workerd`.
- Vitest 5 is unsupported (workers-sdk#15618); the plugin emits an unsupported-version warning. The workaround is to pin `~4.1.11`.

## Open questions

- Does `createTestHarness()` support WebSocket upgrades from Node/Playwright clients end to end, including hibernation? Not documented; needs a spike.
- How are multiple logical timers multiplexed onto a single DO alarm, and how is the clock injected into the DO so tests stay deterministic?
- Which runtime proves Docker parity in CI: e2e against the Docker image, or `workerd` inside Docker?
- CI shape: split Vitest projects (parallel pure suites plus a serial DO-WebSocket project), and pin Vitest 4.x (Renovate/Dependabot rule) until workers-sdk#15618 ships.
