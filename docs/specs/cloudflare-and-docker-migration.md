# Spec: run Manhunt on Cloudflare's free plan and on any Docker host

This spec consolidates every decision from the wayfinder map [Wayfinder: run Manhunt on Cloudflare free tier and Docker](https://github.com/sschorer/manhunt/issues/53). Each decision's full reasoning lives in its linked ticket; this document is the build target and the input for `/to-tickets`.

Domain terms (Game, Lobby, Join code, Seat, Grace period, Host, Hunter, Hider, Ping reveal, Catch, Catch radius, Boundary, Elimination) follow `server/CONTEXT.md`.

## Goal

- **One codebase, two targets.** The TypeScript backend runs on **Cloudflare Workers and Durable Objects on the free plan** and, from the same build, as a **self-hosted Docker image**. Both targets have full feature parity.
- **Frontend on the same origin.** The PWA is served by the same deployment and origin as the API and WebSockets.
- **Load assumption:** a handful of private friends' games a week.

## Decision index

| Area | Ticket |
|------|--------|
| PWA hosting | [How should the PWA be hosted on Cloudflare?](https://github.com/sschorer/manhunt/issues/59) |
| workerd on Docker | [Can workerd run the app in production on Docker?](https://github.com/sschorer/manhunt/issues/54), [Spike: does a workerd Docker container keep DO data, alarms and WebSockets across restarts?](https://github.com/sschorer/manhunt/issues/67) |
| Free-plan budget | [Does our load fit the Cloudflare free plan?](https://github.com/sschorer/manhunt/issues/55) |
| Testing on Workers | [How do we test on Workers?](https://github.com/sschorer/manhunt/issues/58) |
| Password hashing (superseded by dropping accounts) | [Which password hashing fits Workers' CPU limits?](https://github.com/sschorer/manhunt/issues/57) |
| Web Push feasibility | [Can Workers send Web Push?](https://github.com/sschorer/manhunt/issues/56), [Spike: measure Web Push CPU in a Durable Object on a free-plan account](https://github.com/sschorer/manhunt/issues/68) |
| Runtime, seams, layout, accounts | [How will the backend run on both targets?](https://github.com/sschorer/manhunt/issues/60) |
| Wire protocol | [What replaces Socket.IO?](https://github.com/sschorer/manhunt/issues/61) |
| Origin | [Which production origin does the Cloudflare deployment use?](https://github.com/sschorer/manhunt/issues/66) |
| Live game model | [How does a live game map onto Durable Objects?](https://github.com/sschorer/manhunt/issues/62) |
| Durable data | [Where does the remaining durable data live?](https://github.com/sschorer/manhunt/issues/63) |
| Web Push design | [How does Web Push work on Workers?](https://github.com/sschorer/manhunt/issues/65) |
| Releases | [What does a Cloudflare-ready GitHub release contain, and how is it deployed?](https://github.com/sschorer/manhunt/issues/69) |
| Build, CI, tests, local dev | [How do build, CI, tests and local development work?](https://github.com/sschorer/manhunt/issues/70) |
| Operations | [How are both deployments operated day to day?](https://github.com/sschorer/manhunt/issues/71) |
| Port order | [In what order is the port done?](https://github.com/sschorer/manhunt/issues/72) |

Architecture decision records: [0005](../adr/0005-one-workers-runtime-for-cloudflare-and-docker.md), [0006](../adr/0006-durable-object-sqlite-per-game.md), [0007](../adr/0007-no-accounts-in-v0-2.md), [0008](../adr/0008-no-cloudflare-deploys-from-github.md).

## Runtime and code layout

- **One runtime everywhere.** The backend is a Worker plus Durable Objects:
  - Cloudflare runs it directly.
  - The Docker image runs the **same bundle** on a **pinned `workerd`** in `debian:bookworm-slim`.
- **Web standards only.** No `nodejs_compat` and no `node:` imports. Use `crypto.randomUUID`, `crypto.getRandomValues` and WebCrypto.
- **Layout:**
  - `server/`: the backend. The game core stays in its existing folders; host modules sit alongside (e.g. `server/worker.ts`, `server/rooms/`).
  - `shared/`: the wire protocol (frame types, message payloads, validators, close codes, protocol version), imported by `client/` and `server/`. This replaces hand-mirrored copies in the client.
  - `deploy/`: `wrangler.jsonc`, `config.capnp`, Dockerfile and compose file.
- **Seams:**
  - **Game core:** plain TypeScript with no `cloudflare:*` imports and no platform objects, tested with plain Vitest.
  - **Host modules:** the only code touching the platform, tested with `@cloudflare/vitest-plugin`.
  - **No storage or timer interfaces:** each has a single real implementation.

## Game core

One module instance per Game:

```ts
const game = restoreGame(snapshot, config)   // or createGame(host, config)
game.apply(command, now): Effect[]
game.nextDeadline(): number | null
game.snapshot(): GameSnapshot
```

- **Commands:** `join`, `set_role`, `set_boundary`, `set_ready`, `start_game`, `leave_game`, `position_update`, `claim_catch`, `push_subscribe`, `push_unsubscribe`, `seat_dropped`, `seat_reconnected`, `timers_due`.
- **Effects:**
  - `send(to: seat | role | everyone, message)`;
  - `reply(requestId, body)`;
  - `close(seat, code)`;
  - `durableChanged`;
  - push notification effects (caught → the caught Hider, reveal → Hunters, game over → everyone).
- **Time:** `now` is always passed in; tests drive time directly.
- **Deadlines inside the core:** the Ping reveal interval, the game-end countdown, one Grace period per Seat, and the retention deadlines (see [Durable data and retention](#durable-data-and-retention)).
- **Rules ported unchanged:**
  - Catch radius 15 m.
  - Ping reveal every 3 min.
  - Game length 30 min.
  - Speed plausibility 150 m/s.
  - One Boundary warning before Elimination.
  - At least 2 players to start.
  - Today's lobby rules (Host, roles, ready).
- **Overrides:** today's environment overrides (Grace period, ping interval, game length) become Worker variables: `vars` in `wrangler.jsonc`, `fromEnvironment` bindings in `config.capnp`. Per-game configurable settings are out of scope.

## GameRoom Durable Object

- **One Durable Object per Game:** one `GameRoom` per Game, from creation through the Lobby and play to its end.
- **Host loop:**
  1. `apply` the command.
  2. Carry out the effects.
  3. Persist the snapshot when `durableChanged`.
  4. Set the single alarm to `nextDeadline()`.
  5. When the alarm fires, apply `timers_due`.
- **Live positions:** kept in memory **and** mirrored onto each player's own WebSocket attachment (`serializeAttachment`, together with the Seat). After hibernation they are rebuilt from attachments; a full restart loses them until the next update cycle. Positions are **never** written to SQLite.
- **Broadcasts:** for each accepted `position_update`, the core emits one `game_state` per audience, sent immediately with no batching:
  - the Hunters' view, with Hiders filtered out except during a Ping reveal;
  - the Hiders' view.
- **Seats:**
  - A closing socket becomes `seat_dropped`.
  - The Seat is released when its Grace period deadline passes, **in every phase including the Lobby**.
  - A newer socket for the same Seat replaces the old one (close `4003`).
- **Game over:**
  - `game_over` with the summary goes to everyone, then all sockets close with `4002`.
  - A later connection receives `game_over` again, then `4002`.
- **Heartbeat:** the literal text frame `"ping"` is answered with `"pong"` by `setWebSocketAutoResponse`, without waking the object.
- **Logging:** errors, game lifecycle events (created, started, ended, deleted) and rejected connections with their close code. **Never positions or player names.**

## Durable data and retention

- **Only in `GameRoom` Durable Objects:** no accounts, history or statistics exist outside a Game.
- **Join code to Game:**
  - The Durable Object id is `idFromName(joinCode)`, and `gameId` is that id's string form.
  - A Join code is 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
  - Creating a Game picks a random code and asks that object to claim it, retrying on a collision. No directory object.
- **Storage shape:**
  - One table `game` with one row `(snapshot JSON, version)`, written on `durableChanged`.
  - The snapshot holds: roster, Seats (including each Seat's push subscription), roles, ready state, Boundary, boundary warnings and Eliminations, Catches, start time, original Hiders, and deadlines.
- **Schema changes:**
  - The table is created on construction if missing.
  - `version` is upgraded in plain TypeScript inside `restoreGame`.
  - A release keeps loading the previous snapshot version for at least 24 h.
  - `db/schema.sql` and `db/migrate.ts` are removed.
- **Retention:** each of these ends in `ctx.storage.deleteAll()`, which frees the Join code:
  - the last Seat is released (any phase);
  - 24 h after `game_over`;
  - 24 h after creation.

## Worker entry and HTTP API

| Route | Purpose |
|-------|---------|
| `POST /api/games` | Create a Game; returns `{ game, playerId }` and sets the seat cookie. |
| `POST /api/games/join` | Join by `{ code, name }`; returns `{ game, playerId }` and sets the seat cookie. |
| `DELETE /api/games/:gameId/seat` | Clear the seat cookie after leaving or game over. |
| `GET /ws/games/:gameId?v=<protocol>` | WebSocket upgrade, routed with `idFromString(gameId)`. |
| `GET /health` | `{ ok, version, protocol }`. |
| `GET /api/push/vapid-public-key` | `{ key }`, or `null` when push is off. |

- **Seat cookie:**
  - Attributes: `HttpOnly; Secure; SameSite=Strict; Path=/ws/games/<gameId>`.
  - It holds the Seat's resume token and is checked at upgrade **together with the `Origin` header**, before the connection reaches the Game.
  - No unauthenticated socket ever exists.
- **Origin check:** the host in `Origin` must equal the request's `Host`, unless the optional `PUBLIC_ORIGIN` variable overrides it.
- **Client seat memory:** the client keeps the non-secret `{ gameId, playerId }` in `localStorage` and reconnects after a reload. A `4001` close clears it.
- **Route lists kept in sync:** Cloudflare's `run_worker_first` is `["/api/*", "/ws/*", "/health"]`. The Workbox `navigateFallbackDenylist` and the Docker asset Worker use the same list.

## Wire protocol

- **Transport:** plain WebSockets, one socket per Game, JSON text frames. Message names and payload shapes from today's `server/protocol/messages.ts` are kept and move to `shared/`.

| Frame | Shape | Used for |
|-------|-------|----------|
| Event | `{ "t": "lobby_update", "d": { … } }` | Server broadcasts, `position_update` |
| Request | `{ "t": "claim_catch", "id": 7, "d": { … } }` | Every client message that expects a reply |
| Reply | `{ "re": 7, "d": { … } }` | Today's `LobbyAck` / `CatchAck` bodies |

- **Requests:**
  - Each has a client-side timeout.
  - Requests still pending fail with `disconnected` when the socket drops.
  - Requests are **never resent automatically**, because `claim_catch` and `start_game` aren't idempotent.
- **Reconnect:** `partysocket` handles backoff. Missed messages aren't replayed; a reconnect receives a full snapshot (game, roster, current `game_state`).
- **Liveness:** the client sends `"ping"` every 25 s. The connection is considered dead after 10 s without `"pong"`; any server message also counts as proof of life.
- **Protocol version:** one integer in `shared/`, raised only for breaking changes, sent as `?v=` on connect.

| Close code | Meaning | Client reaction |
|------------|---------|-----------------|
| `4001` | Seat token rejected or Seat gone | Forget the stored Seat |
| `4002` | Game ended | Show the end screen |
| `4003` | Replaced by a newer connection for the same Seat | Don't reconnect |
| `4004` | Protocol version out of date | Reload to get the new build |

## Web Push

- **Where and how:** push is sent from `GameRoom` with `@block65/webcrypto-web-push` (RFC 8291 `aes128gcm` plus VAPID) and `fetch`.
  - Measured on the free plan at ~1.6 ms CPU per push inside a Durable Object.
  - From a Worker it would exceed the 10 ms CPU limit, and `waitUntil` doesn't help.
- **Sending:**
  - Push effects run after the same command's game messages, concurrently (`Promise.allSettled`), without blocking the next message.
  - 10 s timeout (`AbortSignal.timeout`).
  - `redirect: 'manual'`; any `3xx` is a failure.
  - `404`/`410` removes the Seat's subscription.
  - Other failures are logged without the endpoint URL and never retried.
- **Endpoint check** (at subscribe and before each send):
  - `https` on the default port.
  - Host isn't an IP literal, contains a dot, and isn't `localhost` or `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`.
  - **Allowlist:** `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`.
  - On Docker, workerd's outbound network also denies NAT64 `64:ff9b::/96` and `0.0.0.0/8`.
- **VAPID keys:**
  - Cloudflare: `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` via `wrangler secret put`, with `VAPID_SUBJECT` as a Worker variable.
  - Docker: all three via `fromEnvironment`.
  - Key generation: `npm run vapid:keys` generates keys with WebCrypto.
  - Push is off without both keys; a real `VAPID_SUBJECT` is required, otherwise push stays off with a logged warning.

| Notification | Recipients | `ttl` | `urgency` | `topic` |
|--------------|------------|-------|-----------|---------|
| "You've been caught!" | Caught Hider | 1 h | `high` | — |
| "Hiders revealed" | Hunters | 180 s | `normal` | `reveal-<gameId>` |
| "Game over" | Everyone | 1 h | `normal` | — |

## Frontend, origin and configuration

- **Frontend hosting:**
  - Cloudflare: Workers Static Assets from the same Worker (`not_found_handling: "single-page-application"`).
  - Docker: a small asset Worker inside `workerd` serves `dist/` with SPA fallback and content types.
  - Cache headers come from one `_headers` file (e.g. `immutable` on `/assets/*`) that both read.
- **One origin per deployment:**
  - Cloudflare uses a **Workers Custom Domain** on the owner's Cloudflare-managed domain, with `workers_dev` and preview URLs **disabled**.
  - Docker uses the operator's `DOMAIN` behind Caddy (default) or a Cloudflare Tunnel.
  - Cookies are always `Secure`.
  - `VITE_SERVER_URL` and the Vite dev proxy are removed.
- **Independent installations:** a Cloudflare deployment and any Docker deployment each have their own Games and VAPID keys; nothing is shared.

## Docker target

- **Image:** pinned `workerd` binary plus `curl` on `debian:bookworm-slim`, serving plain HTTP on 8080. Includes:
  - the Worker bundle;
  - the asset Worker;
  - a hand-maintained `config.capnp` with `enableSql`, a `uniqueKey` that never changes, `localDisk` storage on `/data`, and `fromEnvironment` bindings.
- **Compose:**
  - `app`: volume on `/data`, `restart: unless-stopped`, health check `curl -fsS localhost:8080/health`, `stop_grace_period: 3s`. workerd waits on open sockets instead of exiting on SIGTERM, and data survives the forced stop.
  - `caddy`: TLS for `DOMAIN`.
  - Optional `tunnel` profile with `cloudflared`.
- **Drift check:** a CI end-to-end check against the image catches drift between `config.capnp` and `wrangler.jsonc`.

## Releases and deployment

- **Rule: nothing in GitHub deploys to Cloudflare.** No `wrangler deploy` in Actions, no Cloudflare tokens in repo secrets, and no Workers Builds connected to this repo. Deploys happen from the deployer's own machine.
- **One build per `v*` tag** feeds both artifacts:
  - **GHCR image:** `ghcr.io/sschorer/manhunt:<version>`.
  - **Cloudflare release file:** `manhunt-cloudflare-vX.Y.Z.tar.gz` attached to the GitHub release. It contains the bundled Worker, `dist/`, a Wrangler config template with **no account id or domain**, a deploy script and a README.
- **Cloudflare deploy script:**
  1. Reads a local `.env` (`CLOUDFLARE_ACCOUNT_ID`, `MANHUNT_DOMAIN`, optional rule variables, `VAPID_SUBJECT`).
  2. Writes a local `wrangler.jsonc` from the template.
  3. Runs a pinned `wrangler deploy` of the prebuilt bundle, labelled with the release tag.
  4. Verifies `/health` reports that version.
- **Durable Object migrations:** the template carries `migrations` with `new_sqlite_classes: ["GameRoom"]`. Entries only ever get added.
- **Trust:** `SHA256SUMS` plus GitHub artifact attestations for the release file and the image.
- **Before publishing:** CI runs a short end-to-end check (create a Game, join, open the socket, send a position, receive `game_state`) against the Cloudflare release file under `wrangler dev` **and** against the Docker image.
- **Release notes** include a Cloudflare section, the protocol version, the snapshot version, and whether rolling back is safe (only within the same snapshot version).
- **Out of scope:** a "Deploy to Cloudflare" button.

## Build, CI, tests and local development

- **Build:** one Vite build with `@cloudflare/vite-plugin` produces the client and the Worker. The release version is injected at build time (tag, or `git describe` locally); the protocol version is a constant in `shared/`.
- **Local development:**
  - `npm run dev` runs the Worker and Durable Objects in local `workerd` with client hot reload.
  - HTTPS on the local network for phone GPS testing keeps the existing certificate setup.
  - `make docker-dev` runs the Docker target.
  - `compose.dev.yml`, Postgres and Redis are removed.
- **CI on every pull request and push to `master`:**
  1. Lint and typecheck.
  2. Plain Vitest for the game core, `shared/` and the client.
  3. `@cloudflare/vitest-plugin` tests for host modules, plus a serial project (`--max-workers=1 --no-isolate`) for Durable Object WebSocket tests, with Istanbul coverage.
  4. Playwright against the built app served locally (`createTestHarness()`, falling back to `wrangler dev`).
  5. The Docker image build plus the end-to-end check.
- **Node:** CI and `engines` track the newest Node LTS (Node 24 at the time of writing).
- **Vitest:** stays on `^4.x` until `@cloudflare/vitest-plugin` supports Vitest 5.
- **Test migration:**
  - The Socket.IO `app.*` suites become game core tests. Only transport concerns get Worker tests: cookie and `Origin` check, socket replacement, alarms and hibernation, close codes, retention.
  - `auth/`, `db/migrate`, `redis`, `postgres` and the DNS-based `ssrf` tests are dropped; a URL-check test replaces `ssrf`.
  - Client unit tests and the 7 Playwright specs stay, with transport mocks and server startup adapted.

## Operations

- **Cloudflare:**
  - No automated usage monitoring. Typical use is ~6% of the free plan; a heavy day (4 games × 2 h × 12 players) uses ~31% of Durable Object duration.
  - When the daily limit is used up, the client shows a clear message that the server's daily limit is reached and resets at 00:00 UTC.
  - Workers observability logs are enabled.
- **Docker:**
  - **No backups:** the volume holds only live Games, deleted within 24 h. The operator docs say so plainly.
  - Updates via `make pull` and `make up`; logs via `make logs`; `make health` reports `ok`, `version` and `protocol`.
- **workerd:** pinned exactly and changed only through a normal release; release notes call out changes to its experimental on-disk storage.

## Removed

- **Backend stack:** the Node server, Express, Socket.IO, `pg`, `ioredis`, `web-push`.
- **Server folders:** `server/auth/` (accounts, account sessions, scrypt, root bootstrap, web-of-trust vouching), `server/db/`, `server/redis/`, `db/`.
- **Dev and deploy files:** `compose.dev.yml` and the old Dockerfile.
- **Environment variables:** `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `ROOT_USERNAME`, `ROOT_PASSWORD`, `VITE_SERVER_URL`, `DEV_PROXY_TARGET`.

## Out of scope

- Porting the backend to Go.
- The feature issues "Configurable game settings", "Anti-cheat: implausible-speed detection" and "Replay from position history", until after the migration.
- Accounts and web of trust. If strangers creating Games becomes a problem, the planned fallback is an operator-set host passphrase for creating Games, as a separate change.
- High availability and multi-region; the Docker target is single-instance by design.
- A "Deploy to Cloudflare" button.

## Migration phases

The port happens step by step on `master`, with CI green after every merge. The old Node server keeps working until phase 7 deletes it and never runs in production next to the new backend. Each phase is a slice for `/to-tickets`; its "Done when" column is the acceptance criterion.

| # | Phase | Done when |
|---|-------|-----------|
| 0 | **Tooling:**<br>• Node 24<br>• Vite with `@cloudflare/vite-plugin`<br>• `shared/` skeleton<br>• Worker with `/health`<br>• `@cloudflare/vitest-plugin` setup incl. the serial WebSocket project<br>• trivial echo Durable Object | A Playwright test holds a real WebSocket through the local test harness (fallback `wrangler dev`), and CI runs it. |
| 1 | **Shared protocol:**<br>• messages and validators move to `shared/`<br>• frame types, close codes, protocol version<br>• the client imports `shared/` | Client and the transitional old server build against `shared/`; tests pass. |
| 2 | **Game core:**<br>• all rules, deadlines, retention and push effects<br>• `createGame`/`restoreGame`/`apply`/`nextDeadline`/`snapshot`<br>• versioned snapshot upgrade<br>• `app.*` scenarios as core tests | All ported scenarios pass in plain Vitest with no platform imports. |
| 3 | **Worker and `GameRoom` host:**<br>• HTTP routes, seat cookie and `Origin` check<br>• Join code claim<br>• sockets with attachments, the alarm, snapshot persistence, retention<br>• close codes, `"ping"` auto-response<br>• Worker variables, logging | Worker tests cover cookie/`Origin`, socket replacement, alarms and hibernation, close codes and retention. |
| 4 | **Client switch:**<br>• `partysocket` with request/reply<br>• `localStorage` Seat<br>• close-code handling<br>• daily-limit message<br>• hooks migrated<br>• `VITE_SERVER_URL` and proxy removed | All 7 Playwright specs pass against the new backend. |
| 5 | **Web Push:**<br>• sender in `GameRoom`<br>• endpoint check with allowlist<br>• VAPID configuration and `npm run vapid:keys`<br>• per-notification `ttl`/`urgency`/`topic` | Notifier tests and a push end-to-end test pass. |
| 6 | **Docker target:**<br>• workerd image and asset Worker<br>• `config.capnp` with `deny` rules<br>• compose with Caddy, `tunnel` profile, health check, `stop_grace_period`<br>• `make docker-dev`<br>• Docker end-to-end check in PR CI | The end-to-end check passes against the image in CI. |
| 7 | **Cutover and cleanup:**<br>• delete everything under [Removed](#removed)<br>• update README, `CONTRIBUTING.md` and Makefile | Full CI passes with no Node backend in the repo. |
| 8 | **Release pipeline:**<br>• one build producing both artifacts<br>• deploy script with `/health` version check<br>• `SHA256SUMS` and attestations<br>• release notes<br>• end-to-end checks before publishing<br>• operator docs | A dry-run release on `v0.2.0-rc.1` publishes both artifacts. |
| 9 | **First deploy** (owner, from their own machine): see [First Cloudflare deploy checklist](#first-cloudflare-deploy-checklist) | `/health` on the domain reports the release version, and a real Game works. |

The first release on the new stack is **`v0.2.0`**. Its release notes state that accounts were removed and the protocol changed.

## First Cloudflare deploy checklist

1. **Domain:** make sure the domain's DNS is managed by Cloudflare (free plan).
2. **Download:** download `manhunt-cloudflare-v0.2.0.tar.gz`, then verify it with `SHA256SUMS` and `gh attestation verify`.
3. **Settings:** create `.env` with `CLOUDFLARE_ACCOUNT_ID`, `MANHUNT_DOMAIN` and `VAPID_SUBJECT`.
4. **Keys:** run `npm run vapid:keys`, then `wrangler secret put VAPID_PUBLIC_KEY` and `wrangler secret put VAPID_PRIVATE_KEY`.
5. **Deploy:** run the deploy script and confirm it reports the `/health` version.
6. **Test game:** play one test Game on real phones, including a Catch, a Ping reveal, a reconnect and a push notification.
7. **Discount check:** in the dashboard, read the Durable Object request metrics for that Game to confirm whether the 20:1 WebSocket message discount applies to the free daily quota.
8. **Optional:** rename the account's `workers.dev` subdomain (the Web Push spike registered `spike-web-push-cpu`). It's unused, because `workers_dev` is disabled.

## Known risks

- **Experimental storage:** workerd's `localDisk` storage is marked experimental. Pin the version, and read release notes before upgrading.
- **Docker is single-instance,** and every restart or deploy drops sockets on both targets. Clients reconnect and receive a snapshot.
- **Hard free-plan limits:** requests fail until 00:00 UTC once a daily limit is hit.
- **Push allowlist:** a new browser push service needs a code change.
- **No accounts:** anyone who knows the URL can create Games (see the host passphrase fallback under [Out of scope](#out-of-scope)).
