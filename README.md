# Manhunt

A web-based, GPS-driven hide-and-seek game. Players split into **hunters** and
**hiders** and play a real-world game over a bounded area. Each player runs the
app on their phone; an authoritative server tracks positions and enforces the
rules in real time.

## Status

Early scaffold. The repository ships infrastructure (Docker image, CI release
pipeline, reverse proxy), the **Node/Socket.IO server**, and a **Vite + React
PWA client** (currently a landing shell that connects to the server). The game
screens and server logic are tracked in the backlog — see
[`BACKLOG.md`](./BACKLOG.md) and the GitHub issues.

## Architecture

Full documentation lives in [`docs/arc42.md`](./docs/arc42.md), written in the
[arc42](https://arc42.org) format. In short:

- **Client** — TypeScript React + Vite PWA, MapLibre GL map, `watchPosition` GPS, Screen Wake Lock.
- **Server** — TypeScript on Node.js + Socket.IO (run directly via native type stripping, no build step), authoritative game logic (catches, boundary, pings, wins).
- **Redis** — live/ephemeral state and pub/sub.
- **PostgreSQL** — accounts, games, players, events, position history.
- **Caddy** — automatic TLS + WebSocket upgrades.

Position updates run on a fixed **5–10 second** cadence (battery vs. latency trade-off).

## Development

The repo is an npm workspace: the **server** lives at the root, the **client**
in `client/` (`npm install` at the root installs both).

Every common task is wrapped in the [`Makefile`](./Makefile) so you don't need
to remember commands — run `make` to see them all:

```bash
make install         # install server + client deps
make dev             # server on :3000 (node --watch)
make dev-client      # Vite client dev server on :5173, proxies to the server
make build           # build the client into ./dist
make test-all        # unit + e2e tests
make up              # run the full stack with Docker Compose
```

The equivalent npm scripts, if you prefer:

```bash
npm install

npm run dev          # server on :3000 (node --watch)
npm run dev:client   # Vite client dev server on :5173, proxies /socket.io + /health to :3000
```

Open <http://localhost:5173> during development. Build and preview the production
bundle (served by the server itself) with:

```bash
npm run build        # builds the client into ./dist
npm start            # server on :3000, serving ./dist and the socket
```

### Full dev stack in Docker (Postgres + Redis + server + client)

To run everything locally against real Postgres and Redis, use
[`compose.dev.yml`](./compose.dev.yml). Unlike the production stack (`make up`,
a prebuilt image behind Caddy), it runs the **server and client straight from
your working tree with live reload** — the source is bind-mounted and edits hot
reload. It is fully self-contained (throwaway dev credentials, its own project
and volumes, separate from prod):

```bash
make dev-up          # start db, redis, server (:3000) and client (:5173)
make dev-logs        # tail all service logs
make dev-down        # stop the stack  (make dev-reset also wipes the data volume)
```

Then open <https://localhost:5173>. Migrations run automatically on the server's
first boot (`RUN_MIGRATIONS=true`); Postgres (`:5432`) and Redis (`:6379`) are
also published on `localhost` for direct inspection with `psql`/`redis-cli`.

#### Testing GPS from a phone on your LAN

The browser Geolocation API only works in a **secure context**, and
`http://<host-ip>:5173` is not one — so the dev client is served over HTTPS. To
avoid the certificate warnings that phones won't let you skip, the cert is
locally trusted via [mkcert](https://github.com/FiloSottile/mkcert):

```bash
# One-time: install mkcert (Arch/CachyOS shown; see the script for other OSes)
sudo pacman -S mkcert nss

make dev-certs       # mint certs/ for localhost + this host's LAN IP
make dev-up          # brings the stack up over HTTPS
```

`make dev-certs` prints the path to mkcert's **root CA** (`rootCA.pem`). Copy it
to the phone and trust it once (Android: *Settings ▸ Security ▸ Install a
certificate ▸ CA certificate*; iOS: install the profile, then enable it under
*Settings ▸ General ▸ About ▸ Certificate Trust Settings*). Then open
`https://<your-host-LAN-IP>:5173` on the phone — no warning, and GPS works.
Re-run `make dev-certs` if your LAN IP changes.

`make dev-certs` auto-detects your LAN IP on Linux and macOS. If detection fails
(or the host has several interfaces), pass it explicitly:
`HOST_IP=192.168.1.42 make dev-certs`.

> First `make dev-up` installs dependencies inside the containers, so it takes a
> minute; subsequent starts reuse the cached `node_modules` volumes.

If you prefer to run the app/client on the host instead, start just the
databases with `docker compose -f compose.dev.yml up -d db redis` and point the
server at them via `DATABASE_URL=postgres://manhunt:manhunt@localhost:5432/manhunt`
and `REDIS_URL=redis://localhost:6379`.

### Tests

```bash
make test            # Vitest unit tests (server + client)
make e2e             # Playwright end-to-end tests (builds + boots the real server)
make test-all        # both suites
```

First-time e2e setup installs the browser Playwright needs: `make e2e-install`.
CI runs both suites — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

> **Every feature needs both unit tests and e2e tests.** See the testing
> requirements in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Lint

```bash
make lint            # ESLint (JS/JSX) + Stylelint (CSS) + markdownlint (docs)
make lint-fix        # auto-fix what can be fixed
```

### Database

The schema lives in ordered migrations under [`db/migrations/`](./db/migrations)
(with a current snapshot in [`db/schema.sql`](./db/schema.sql)). Apply pending
migrations against the database in `DATABASE_URL`:

```bash
npm run db:migrate   # applies any pending migrations, then exits
```

Migrations are recorded in a `schema_migrations` table, so re-running is a no-op
once up to date. Set `RUN_MIGRATIONS=true` to have the server apply them on boot.
The whole server is TypeScript, run directly by Node's native type stripping —
no build step. Type-check the server and client with `npm run typecheck`.
Evolve the schema by adding a new `NNNN_name.sql` migration (files are immutable
once merged) and updating the snapshot to match.

### WebSocket message contract

All real-time play flows over a single Socket.IO connection. The contract — every
event, its payload schema, and the validator the server runs on every inbound
payload — lives in one place:
[`server/protocol/messages.ts`](./server/protocol/messages.ts). The server is
authoritative and treats every inbound payload as untrusted: a malformed payload
is rejected (with an error ack where the event acks) and never mutates state.

#### Inbound (client → server)

| Event | Payload | Ack | Notes |
| --- | --- | --- | --- |
| `join` | `{ gameId }` | `{ ok }` | Subscribe the socket to a game's broadcasts. |
| `resume` | `{ gameId, playerId, resumeToken }` | `{ ok, game, playerId }` / error | Reclaim a membership after a reconnect. A dropped socket auto-reconnects as a fresh socket; `resume` re-binds its authoritative identity (so its `position_update`/`claim_catch` are accepted again) if the player's slot is still held by the disconnect grace period, and re-seeds the live view. The `resumeToken` is the per-session secret the server minted at create/join (returned in that ack) — since `playerId` is public in the roster, the token is what authenticates the claim. Rejected when the token is wrong or the player isn't mid-reconnect (`resume_denied`), once the grace has elapsed (`player_not_found`), or if the match already ended (`game_ended`). |
| `position_update` | `{ gameId, playerId, lat, lng }` | — | One location tick. `lat`/`lng` are validated to WGS84 bounds; the server stamps the authoritative `recordedAt` and the tick engine drops fixes that imply an impossible speed (teleport/GPS spoof). Malformed or implausible ticks are dropped silently. |
| `claim_catch` | `{ gameId, hunterId, targetId }` | `{ ok, catch }` / `{ ok:false, error, code }` | A hunter claims a catch (`targetId` must differ from `hunterId`). The server verifies the two are within the catch radius from its own positions; an out-of-range claim is rejected (`code: out_of_range`) and a confirmed one flips the caught hider to a hunter. |
| `set_boundary` | `{ boundary: { center: { lat, lng }, radiusM } }` | `{ ok, game, playerId }` / error | Host-only: define the circular play area the rules engine geofences against. `radiusM` is bounded to a sane range. |
| `push_subscribe` | `{ endpoint, keys: { p256dh, auth } }` | `{ ok }` / `{ ok:false, error, code }` | Opt in to Web Push. The browser's subscription is filed against the caller's game and player (identity from the socket, not the payload); requires being in a game. |
| `push_unsubscribe` | — | `{ ok }` | Opt back out; drops the caller's stored push subscription. |
| `create_game` · `join_game` · `set_role` · `set_ready` · `start_game` | see [Lobby](#lobby-rooms-roles-ready-start) | `{ ok, game, playerId }` / error | Room lifecycle; payloads validated by the lobby manager. |

#### Outbound (server → client)

| Event | Payload | Notes |
| --- | --- | --- |
| `game_state` | `{ gameId, positions, reveal? }` | Latest per-player positions, fanned out to the game's room each tick — filtered per recipient's role. `reveal: true` marks a scheduled ping reveal, where hider positions are disclosed to hunters. |
| `catch_confirmed` | `{ gameId, hunterId, targetId, at }` | The server accepted a catch; broadcast to the game's room. |
| `boundary_warning` | `{ gameId, playerId, warnings, warningsRemaining, metersOutside, at }` | Sent to a player the server saw outside the play area, before elimination. |
| `player_eliminated` | `{ gameId, playerId, reason, at }` | Broadcast to the room when the server removes a player from play (`reason: 'boundary'` today). |
| `lobby_update` | `{ game }` | Full roster/status after any lobby change. |
| `game_over` | `{ gameId, summary }` | Broadcast when the server detects a win condition and ends the match. `summary` carries the winner (`hunters`/`hiders`), why (`all_caught`/`timer`), the match span, every catch, and each hider's survival time — the end-screen payload. |

The **catch flow** is wired end to end here and gated by the rules engine
(`server/live/catch.ts`): on a hunter's `claim_catch` the server verifies —
server-side, from the latest reported positions, never trusted from the client —
that the claimant is a hunter, the target an uncaught hider, and the two are
within the **catch radius**. Only a verified claim broadcasts `catch_confirmed`,
flips the caught hider to a hunter, and fans out the updated roster
(`lobby_update`); an out-of-range or otherwise invalid claim is rejected with an
error ack and no state change — see [`BACKLOG.md`](./BACKLOG.md) #12. The **tick
engine** (`server/live/tick.ts`)
ingests each `position_update`, validates it, rejects an implausible jump, writes
the accepted fix, and exposes the latest per-player snapshot to the rules engine.
The **boundary geofence** (`server/live/boundary.ts`) then checks each accepted
fix against the game's play area (set by the host via `set_boundary`): a player
who strays outside is warned (`boundary_warning`), then eliminated
(`player_eliminated`) once the warnings run out — every check server-side, per
[`BACKLOG.md`](./BACKLOG.md) #11. The **ping-reveal scheduler**
(`server/live/ping.ts`) runs a timer per active game: on the configured interval
(`PING_INTERVAL_S`, default 180 s) it forces the game's current positions into a
`game_state` broadcast with the per-role filter lifted, so hunters get a periodic
fix on the hiders and can't just camp — the one exception to per-role filtering,
per [`BACKLOG.md`](./BACKLOG.md) #13. The **outcome tracker**
(`server/live/outcome.ts`) watches for a **win condition**: the match ends when
the last hider is caught (the hunters win, `all_caught`) or when the game's
duration elapses with a hider still free (the hiders win, `timer`, over
`GAME_DURATION_S`, default 1800 s). Either way the server broadcasts `game_over`
with a summary — winner, reason, span, every catch, and each hider's survival
time — the payload the end screen renders, per
[`BACKLOG.md`](./BACKLOG.md) #15. See `docs/arc42.md` §6 for the runtime view.

**Reconnect handling** ([`BACKLOG.md`](./BACKLOG.md) #24) keeps a match playable
across the signal loss a phone in the field will hit. The client's socket
auto-reconnects (capped, jittered backoff, never gives up); until it is back, the
live map keeps every player's **last-known position** on screen — dimmed, behind a
"showing last-known positions" banner — rather than blanking. Because a reconnect
arrives as a brand-new socket the server has dropped from the room, a bare
re-`join` would restore broadcasts but not identity, so the client emits `resume`
to re-bind its authoritative `playerId` — proven with the per-session
**resume token** the server minted at create/join (the roster exposes the
`playerId` to every member, so the token, not the id, authenticates the claim).
The server holds a mid-match player's slot for a grace period
(`DISCONNECT_GRACE_S`, default 30 s): a `resume` inside that window — with a
matching token, and only while a grace removal is actually pending, so a token
can't seize a live session — cancels the pending removal, re-seeds the client's
live view, and restores its ability to send ticks and claim catches. If the grace
elapses first the player is dropped as on any disconnect, and a `resume` into an
already-ended match is rejected so the client resets rather than showing a stale
screen. In the lobby (before start) a disconnect still drops the player
immediately — there's no in-flight match to preserve.

### Web Push notifications

Key game events also reach a player **out of band**, via the browser's push
service, so a backgrounded phone still buzzes ([`BACKLOG.md`](./BACKLOG.md) #23).
A player opts in from the lobby (the client requests notification permission and
registers a `PushSubscription`, handed to the server over `push_subscribe`); the
server keeps the subscription in a per-game store (`server/push/`) and pushes
three events, each to whom it concerns:

- **caught** — to the hider who was just caught (they most want to know, even
  backgrounded).
- **reveal** — to the **hunters** on each scheduled ping reveal (their periodic
  fix on the hiders — mirrors the per-role filter lift).
- **time** — to **everyone** subscribed when the match ends, carrying who won.

Recipients are resolved from the live lobby roster at send time (never a role
cached at subscribe time), and a subscription the push service reports **gone**
(HTTP 404/410) is pruned on the spot. Each payload is encrypted for the
subscription's keys (RFC 8291) and the request is authenticated to the push
service with a **VAPID** JWT — both handled by the
[`web-push`](https://www.npmjs.com/package/web-push) library; the server
advertises its VAPID public key at `GET /api/push/vapid-public-key`.
The service-worker `push`/`notificationclick` handlers live in
[`client/public/push-sw.js`](./client/public/push-sw.js), imported into the
Workbox-generated worker.

Web Push is **entirely optional**: it is disabled unless **both**
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are configured (see
[`.env.example`](./.env.example)) — if either is missing the server advertises no
key, the client never subscribes, and nothing is pushed. Generate a key pair with
`npx web-push generate-vapid-keys`. Subscriptions are in-process hot state, like
the lobby — durable storage is a later concern.

### Live state (Redis)

Hot, ephemeral state — every player's latest position — lives in **Redis**, and
the **broadcaster** fans out `game_state` between server instances over Redis
pub/sub (see [`docs/arc42.md`](./docs/arc42.md) §5.2, ADR-004). On each validated
`position_update` tick (see the [message contract](#websocket-message-contract))
the server writes the reported position to a per-game Redis hash and publishes
the game's positions to every instance, which emit `game_state` to the sockets in
that game's room — **filtered per recipient's role** (resolved from the lobby
roster) so hunters never receive hider coordinates
([BACKLOG.md](./BACKLOG.md) #14), except on a scheduled **ping reveal**
(`server/live/ping.ts`), which lifts the filter for one broadcast so hunters get
a periodic fix on the hiders ([BACKLOG.md](./BACKLOG.md) #13).

Point the server at Redis with `REDIS_URL` (see [`.env.example`](./.env.example);
`docker compose up` provides one). Redis is **optional in development**: with no
`REDIS_URL` the server falls back to an in-process store and loopback
broadcaster, so a single instance (and CI, which has no Redis service) runs
fully — you only need Redis to share hot state across multiple instances.

### Lobby (rooms, roles, ready, start)

Before a match starts, players gather in a **lobby**. The flow is driven over
the socket and the server is authoritative — every action is answered with an
ack and the full roster is broadcast to the room as a `lobby_update`:

- **`create_game` `{ name }`** — hosts a new room and acks with the game
  (including its short **room code**) and the caller's player id. The creator is
  the host (a hunter).
- **`join_game` `{ roomCode, name }`** — joins an existing room by code as a
  hider. Codes are case-insensitive and drawn from an unambiguous alphabet (no
  `O`/`0`/`I`/`1`).
- **`set_role` `{ role }`** and **`set_ready` `{ ready }`** — a player picks
  their own side (`hunter`/`hider`) and readies up.
- **`start_game`** — **host only**; moves the room to `active` once at least two
  players have all readied up.

Lobby state is in-process; a single instance is
fully functional. Durable `games`/`players` rows in PostgreSQL are written by the
persistence layer (out of scope for this milestone). See
[`server/lobby/rooms.ts`](./server/lobby/rooms.ts) and the client
[`Lobby`](./client/src/lobby/Lobby.tsx).

### Client GPS capture (watchPosition + Wake Lock)

Once a match goes `active`, the client starts capturing the device location and
streaming it to the server. This lives in the client `gps/` hooks and is driven
by the [`ActiveGame`](./client/src/game/ActiveGame.tsx) screen:

- **`useGpsCapture`** watches the device with `navigator.geolocation.watchPosition`
  (high accuracy) and **throttles emission to the fixed 5–10s cadence** — the
  browser can report fixes far faster, so the hook holds the newest fix and
  flushes one per cadence (the first goes out immediately). A denied permission
  is a terminal status; a lost signal is transient and the watch recovers.
- **`useWakeLock`** holds a **Screen Wake Lock** so the phone keeps tracking with
  the screen on, re-acquiring it whenever the page returns to the foreground.
  The API is best-effort: **if the request is denied** (no support, a blocking
  permissions policy, low battery) **tracking carries on without it** and the UI
  hints to keep the screen on — it never blocks the game.
- **`useTracking`** ties the two together and emits a
  [`position_update`](#websocket-message-contract) for each captured fix. The
  server is authoritative and stamps its own `recordedAt`.

## Quickstart (Docker)

```bash
cp .env.example .env      # then edit secrets
docker compose up -d      # builds the client, serves it + the server on :3000 (behind Caddy on :443)
```

A compiled static design preview still lives in `public/index.html` (with the
editable source mockup in `docs/mockup/`); the server serves the built client
from `dist/` when present and falls back to `public/` otherwise.

### HTTPS & WebSockets (Caddy)

The stack fronts the app with **Caddy** ([`Caddyfile`](./Caddyfile)), which
gives you HTTPS with **no manual certificates**:

- **TLS is automatic.** Caddy provisions and renews a certificate for
  `$DOMAIN` — an ACME cert from Let's Encrypt/ZeroSSL for a real public domain,
  or a cert from its own internal CA for `localhost`/loopback (issued locally;
  import Caddy's root CA to trust it in a browser). HTTP on `:80` is redirected
  to HTTPS on `:443`.
- **WebSockets just work.** `reverse_proxy` upgrades `Upgrade: websocket`
  requests (Socket.IO over WSS) into a transparent bidirectional tunnel, so
  live position updates flow over the same HTTPS origin.
- **Correct client info behind the proxy.** Caddy forwards
  `X-Forwarded-{For,Proto,Host}`; the server trusts them via
  [`trust proxy`](./server/app.ts) (`TRUST_PROXY`, default the single Caddy
  hop) so `req.secure`/`req.ip` are accurate.

Point `DOMAIN` at your host in `.env` and make sure its DNS `A`/`AAAA` record
resolves to the machine (ports `80` and `443` reachable) so ACME can issue the
certificate.

**Validate a running stack** against issue #5's acceptance — HTTPS reachable
and WebSocket upgrades succeeding through the proxy:

```bash
DOMAIN=manhunt.example.com scripts/verify-proxy.sh
```

To validate locally with no public DNS, set `DOMAIN=localhost` and
`docker compose up -d`; Caddy serves `localhost` over HTTPS with its internal
CA. That CA isn't in the system trust store by default, so
`DOMAIN=localhost scripts/verify-proxy.sh` passes `curl -k` to skip browser
trust — it checks `/health` over HTTPS and asserts the Socket.IO endpoint
returns `101 Switching Protocols`. To make browsers trust it, import Caddy's
root CA (`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`).

## Release

Tag a version and the `release` workflow (`.github/workflows/release.yml`) does two things:

1. Builds the container image, **smoke-tests it end to end** (boots the image
   and waits for `/health` to answer) and — only if that passes — pushes it to
   GHCR as both `:<version>` and `:latest`.
2. Creates a GitHub Release for the tag, with a changelog generated from your
   Conventional Commits (grouped into Features / Bug fixes / etc.) and the image
   pull command. Tags containing a hyphen (e.g. `v0.2.0-rc.1`) are marked as
   pre-releases automatically.

```bash
git tag v0.1.0 && git push --tags
```

The workflow authenticates to GHCR with the built-in `GITHUB_TOKEN` (no secret
to configure) via the `packages: write` permission it already grants itself.

On the server: `docker compose pull && docker compose up -d`.

### Container image (GHCR)

The published image is `ghcr.io/sschorer/manhunt`:

```bash
docker pull ghcr.io/sschorer/manhunt:latest      # or a specific :<version>, e.g. :0.1.0
```

**Package visibility.** A GHCR package inherits no visibility from its
repository — a new package is **private** until you change it. Pick one:

- **Public (recommended for this project).** In the repo, open
  **Packages → `manhunt` → Package settings → Danger Zone → Change visibility →
  Public**. Anonymous `docker pull` then works with no credentials, which is
  what `docker compose pull` on a deploy host expects.
- **Private with a pull token.** Leave the package private and authenticate on
  the host before pulling. GHCR only accepts a **classic PAT** with the
  **`read:packages`** scope (or `GITHUB_TOKEN` inside GitHub Actions) —
  fine-grained tokens can't authenticate to the container registry. Then:

  ```bash
  echo "$GHCR_PULL_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
  ```

  Grant the token access to the package under **Package settings → Manage
  Actions access / Manage access** so the deploy host can pull it.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The repository is public; never
commit secrets — configuration is via environment (`.env`, not committed).

## License

MIT — see [`LICENSE`](./LICENSE).
