# Manhunt

A web-based, GPS-driven hide-and-seek game. Players split into **Hunters** and
**Hiders** and play a real-world Game over a bounded area. Each player runs the
app on their phone; an authoritative backend tracks positions and enforces the
rules in real time.

## Status

The game loop is complete — Lobby, live positions, Boundary, Catch, Ping reveal,
game over, reconnect and Web Push — and runs on **Cloudflare Workers and Durable
Objects** or, from the same bundle, on **workerd in Docker**. Remaining work is
tracked in [`BACKLOG.md`](./BACKLOG.md) and the GitHub issues.

## Architecture

Full documentation lives in [`docs/arc42.md`](./docs/arc42.md), written in the
[arc42](https://arc42.org) format. In short:

- **Client** — TypeScript React + Vite PWA, MapLibre GL map, `watchPosition` GPS, Screen Wake Lock.
- **Backend** — one TypeScript **Worker** plus a `GameRoom` **Durable Object** per Game, holding all authoritative game logic (Catches, Boundary, Ping reveals, wins). Web standards only: no `node:` imports, no `nodejs_compat`.
- **Storage** — each Game's snapshot in its own Durable Object SQLite row. No Postgres, no Redis, no accounts; positions are never persisted.
- **Two targets, one bundle** — Cloudflare runs the Worker directly; the Docker image runs the same bundle on a pinned [`workerd`](https://github.com/cloudflare/workerd).

Position updates run on a fixed **5–10 second** cadence (battery vs. latency trade-off).

## Development

The repo is an npm workspace: the **backend** lives at the root (`server/`,
`shared/`), the **client** in `client/` (`npm install` at the root installs both).

Every common task is wrapped in the [`Makefile`](./Makefile) so you don't need to
remember commands — run `make` to see them all:

```bash
make install         # install every dependency
make dev             # PWA + Worker in local workerd on :5173
make build           # PWA into ./dist, Worker into ./dist-worker
make test-all        # unit + e2e tests
make docker-dev      # build the image and run it on https://localhost
```

The equivalent npm scripts, if you prefer:

```bash
npm install
npm run dev          # Vite on :5173: the PWA plus the Worker in local workerd
npm run build        # one build producing both the PWA and the Worker bundle
```

Open <http://localhost:5173> during development. `@cloudflare/vite-plugin` runs
the real Worker and its Durable Objects in local `workerd` behind the same
origin, so `/api/*`, `/ws/*` and `/health` reach exactly the backend production
runs — there is no separate server to start and no dev proxy.

Rule overrides (`DISCONNECT_GRACE_S`, `PING_INTERVAL_S`, `GAME_DURATION_S`) and
the Web Push settings are Worker variables. Locally they come from `vars` in
[`deploy/wrangler.jsonc`](./deploy/wrangler.jsonc); on the Docker target from
`deploy/.env` (see [`deploy/.env.example`](./deploy/.env.example)).

### Testing GPS from a phone on your LAN

The browser Geolocation API only works in a **secure context**, and
`http://<host-ip>:5173` is not one — so the dev server can be served over HTTPS.
To avoid the certificate warnings that phones won't let you skip, the cert is
locally trusted via [mkcert](https://github.com/FiloSottile/mkcert):

```bash
# One-time: install mkcert (Arch/CachyOS shown; see the script for other OSes)
sudo pacman -S mkcert nss

make dev-certs       # mint certs/ for localhost + this host's LAN IP
DEV_HTTPS=1 DEV_HTTPS_CERT=certs/dev-cert.pem DEV_HTTPS_KEY=certs/dev-key.pem make dev
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

### Tests

```bash
make test            # Vitest: game core, shared/, the Worker projects, the client
make e2e             # Playwright (builds, then runs the Worker in local workerd)
make test-all        # both suites
make docker-e2e      # build the image and play a real Game against it
```

The game core is plain TypeScript with no platform imports, so it runs in plain
Vitest. The host modules (Worker entry, `GameRoom`) run under
`@cloudflare/vitest-plugin`, with a second **serial** project
(`--max-workers=1 --no-isolate`) for the Durable Object WebSocket tests.

First-time e2e setup installs the browser Playwright needs: `make e2e-install`.
CI runs every suite — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

> **Every feature needs both unit tests and e2e tests.** See the testing
> requirements in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Lint

```bash
make lint            # ESLint (JS/TS/JSX) + Stylelint (CSS) + markdownlint (docs)
make lint-fix        # auto-fix what can be fixed
```

The backend and client are both **TypeScript**. Nothing is compiled ahead of
time: the client and the Worker come out of one Vite build, and the tooling in
`scripts/` runs `.ts` directly via Node's native type stripping. Type-check
everything with `npm run typecheck`.

## HTTP API

| Route | Purpose |
| --- | --- |
| `POST /api/games` | Create a Game; returns `{ game, playerId }` and sets the Seat cookie. |
| `POST /api/games/join` | Join by `{ code, name }`; returns `{ game, playerId }` and sets the Seat cookie. |
| `DELETE /api/games/:gameId/seat` | Clear the Seat cookie after leaving or game over. |
| `GET /ws/games/:gameId?v=<protocol>` | WebSocket upgrade for that Game. |
| `GET /health` | `{ ok, version, protocol }`. |
| `GET /api/push/vapid-public-key` | `{ key }`, or `null` when push is off. |

**The Seat cookie** (`HttpOnly; Secure; SameSite=Strict; Path=/ws/games/<gameId>`)
holds the Seat's resume token. It is checked together with the `Origin` header at
the WebSocket upgrade, before the connection reaches the Game, so no
unauthenticated socket ever exists. The client keeps only the non-secret
`{ gameId, playerId }` in `localStorage` and reconnects after a reload.

## WebSocket message contract

All real-time play flows over **one WebSocket per Game**, carrying JSON text
frames. The contract — every message, its payload schema, and the validator the
Game runs on every inbound payload — lives in one place:
[`shared/`](./shared/index.ts), imported by both the client and the backend. The
Game is authoritative and treats every inbound payload as untrusted: a malformed
payload is rejected (with an error reply where the message expects one) and never
mutates state.

Three frame shapes:

| Frame | Shape | Used for |
| --- | --- | --- |
| Event | `{ "t": "lobby_update", "d": { … } }` | Game broadcasts, and `position_update` |
| Request | `{ "t": "claim_catch", "id": 7, "d": { … } }` | Every client message that expects a reply |
| Reply | `{ "re": 7, "d": { … } }` | The answer to the request whose `id` equals `re` |

A request has a client-side timeout, fails with `disconnected` when the socket
drops, and is **never resent automatically** — `claim_catch` and `start_game`
aren't idempotent. Liveness is the literal text frame `"ping"`, answered with
`"pong"` by the Durable Object's auto-response without waking it.

### Inbound (client → Game)

| Message | Payload | Reply | Notes |
| --- | --- | --- | --- |
| `set_role` | `{ role }` | `{ ok }` / error | A player picks their own side (`hunter`/`hider`) in the Lobby. |
| `set_ready` | `{ ready }` | `{ ok }` / error | Ready up, or stand down. |
| `start_game` | `{}` | `{ ok }` / error | **Host only**; moves the Game to `active` once at least two players have all readied up. |
| `set_boundary` | `{ boundary: { center: { lat, lng }, radiusM } }` | `{ ok }` / error | Host-only: define the circular Boundary the rules geofence against. `radiusM` is bounded to a sane range. |
| `leave_game` | — | `{ ok }` | Give up this Seat. |
| `position_update` | `{ gameId, playerId, lat, lng }` | — | One location tick. `lat`/`lng` are validated to WGS84 bounds; the Game stamps the authoritative `recordedAt` and drops fixes that imply an impossible speed (teleport/GPS spoof). Malformed or implausible ticks are dropped silently. |
| `claim_catch` | `{ gameId, hunterId, targetId }` | `{ ok, catch }` / `{ ok:false, error, code }` | A Hunter claims a Catch. The Game verifies the two are within the Catch radius from its own positions; an out-of-range claim is rejected (`code: out_of_range`) and a confirmed one flips the caught Hider to a Hunter. |
| `push_subscribe` | `{ endpoint, keys: { p256dh, auth } }` | `{ ok }` / `{ ok:false, error, code }` | Opt in to Web Push. The subscription is filed against the Seat the socket speaks for, never a player named in the payload. |
| `push_unsubscribe` | — | `{ ok }` | Opt back out; drops this Seat's stored subscription. |

### Outbound (Game → client)

| Message | Payload | Notes |
| --- | --- | --- |
| `lobby_update` | `{ game }` | The full roster and status after any change, and the first message a socket receives. |
| `game_state` | `{ gameId, positions, reveal? }` | Latest per-player positions, **filtered per recipient's role**. `reveal: true` marks a scheduled Ping reveal, where Hider positions are disclosed to Hunters. |
| `catch_confirmed` | `{ gameId, hunterId, targetId, at }` | The Game accepted a Catch. |
| `boundary_warning` | `{ gameId, playerId, warnings, warningsRemaining, metersOutside, at }` | Sent to the player the Game saw outside the Boundary, before Elimination. |
| `player_eliminated` | `{ gameId, playerId, reason, at }` | Sent to everyone when a player is taken out of play (`reason: 'boundary'` today). |
| `game_over` | `{ gameId, summary }` | The Game ended. `summary` carries the winner (`hunters`/`hiders`), why (`all_caught`/`timer`), the match span, every Catch, and each Hider's survival time — the end-screen payload. |

### Close codes

| Code | Meaning | Client reaction |
| --- | --- | --- |
| `4001` | Seat token rejected, or the Seat is gone | Forget the stored Seat |
| `4002` | Game ended | Show the end screen |
| `4003` | Replaced by a newer connection for the same Seat | Don't reconnect |
| `4004` | Protocol version out of date | Reload to get the new build |

The protocol version is one integer in [`shared/version.ts`](./shared/version.ts),
raised only for breaking changes and sent as `?v=` on connect.

## The game core and its host

The rules live in a **platform-free game core** ([`server/game/`](./server/game)),
one module instance per Game:

```ts
const game = restoreGame(snapshot, config)   // or createGame(host, config)
game.apply(command, now): Effect[]
game.nextDeadline(): number | null
game.snapshot(): GameSnapshot
```

`now` is always passed in, so tests drive time directly and the core has no
imports from `cloudflare:*` or `node:`. Every decision that matters is made here:
the Lobby rules, the speed-plausibility guard on each tick, the per-role
`game_state` views (Hunters never receive Hider coordinates outside a Ping
reveal), the **Catch radius** check, the Boundary warning and the Elimination that
follows, the win conditions, each dropped Seat's Grace period, the retention
deadlines, and who each push notification goes to.

The host — the `GameRoom` Durable Object ([`server/rooms/`](./server/rooms)) —
does nothing but carry the core's decisions out: apply the command, execute the
effects, persist the snapshot when the core says it changed, and point the Game's
**single alarm** at `nextDeadline()`. Every timer (Ping reveal, the game-end
countdown, Grace periods, retention) is a deadline in the snapshot, so they
survive eviction and restarts.

**Live positions** are kept in memory and mirrored onto each player's WebSocket
attachment, so they are rebuilt after hibernation; they are **never** written to
SQLite. Logs carry errors, lifecycle events and rejected connections with their
close code — never positions or player names.

**Reconnect** ([`BACKLOG.md`](./BACKLOG.md) #24): a closing socket becomes
`seat_dropped` and the Seat is held for the Grace period (`DISCONNECT_GRACE_S`,
default 30 s) in **every** phase, including the Lobby. `partysocket` reconnects
with backoff; until it is back the live map keeps every player's last-known
position on screen, dimmed behind a "showing last-known positions" banner. The
Seat cookie authenticates the new socket at upgrade, and the Game answers with a
full snapshot — missed messages are never replayed. A newer socket for the same
Seat replaces the old one (`4003`).

**Retention**: a Game's storage is deleted — which frees its Join code — when its
last Seat is released (any phase), 24 h after it ended, or 24 h after it was
created.

## Web Push notifications

Key events also reach a player **out of band**, via the browser's push service,
so a backgrounded phone still buzzes ([`BACKLOG.md`](./BACKLOG.md) #23). A player
opts in from the Lobby; the subscription travels over the Game's own socket and is
stored on that Seat. Push is sent from `GameRoom` with
[`@block65/webcrypto-web-push`](https://www.npmjs.com/package/@block65/webcrypto-web-push)
(RFC 8291 `aes128gcm` plus VAPID) and `fetch` — from a Durable Object, because a
Worker's 10 ms CPU limit can't cover it.

| Notification | Recipients | `ttl` | `urgency` | `topic` |
| --- | --- | --- | --- | --- |
| "You've been caught!" | The caught Hider | 1 h | `high` | — |
| "Hiders revealed" | The Hunters | 180 s | `normal` | `reveal-<gameId>` |
| "Game over" | Everyone | 1 h | `normal` | — |

Sends run after the same command's game messages, concurrently, with a 10 s
timeout and no redirects. A `404`/`410` removes that Seat's subscription; other
failures are logged without the endpoint URL and never retried. Every endpoint is
checked at subscribe **and** before each send: `https` on the default port, not an
IP literal or a local name, and on the allowlist of the four browser push
services. The service-worker `push`/`notificationclick` handlers live in
[`client/public/push-sw.js`](./client/public/push-sw.js), imported into the
Workbox-generated worker.

Web Push is **entirely optional**: it stays off unless `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and a real `VAPID_SUBJECT` are all configured — the backend
then advertises no key, the client never subscribes, and nothing is pushed.
Generate a key pair with `npm run vapid:keys`. Each installation has its own keys;
a Cloudflare deployment and a Docker deployment share nothing.

## Client GPS capture (watchPosition + Wake Lock)

Once a Game goes `active`, the client starts capturing the device location and
streaming it over the Game's socket. This lives in the client `gps/` hooks and is
driven by the [`ActiveGame`](./client/src/game/ActiveGame.tsx) screen:

- **`useGpsCapture`** watches the device with `navigator.geolocation.watchPosition`
  (high accuracy) and **throttles emission to the fixed 5–10 s cadence** — the
  browser can report fixes far faster, so the hook holds the newest fix and
  flushes one per cadence (the first goes out immediately). A denied permission
  is a terminal status; a lost signal is transient and the watch recovers.
- **`useWakeLock`** holds a **Screen Wake Lock** so the phone keeps tracking with
  the screen on, re-acquiring it whenever the page returns to the foreground.
  The API is best-effort: **if the request is denied** (no support, a blocking
  permissions policy, low battery) **tracking carries on without it** and the UI
  hints to keep the screen on — it never blocks the game.
- **`useTracking`** ties the two together and sends a
  [`position_update`](#inbound-client--game) for each captured fix. The Game is
  authoritative and stamps its own `recordedAt`.

## Running it

Both targets run the **same Worker bundle** and have full feature parity. Each
installation has its own Games and its own VAPID keys; nothing is shared between
them.

### Self-hosted on Docker

The self-hosted target lives in [`deploy/`](./deploy) and runs the Worker bundle
on a pinned `workerd`:

```bash
make docker-dev      # build the image and run it on https://localhost
make logs            # tail its logs
make health          # read /health (ok, version, protocol)
make down            # stop it, keeping the Games on the volume
make docker-e2e      # play a real Game against the image, then restart it
```

`make docker-dev` uses `DOMAIN=localhost`, so Caddy signs with its own CA and the
browser warns once. For a real deployment:

```bash
make env                   # creates deploy/.env from the example
$EDITOR deploy/.env        # set DOMAIN (and TAG to a release)
make up
```

| File | What it is |
| --- | --- |
| [`deploy/Dockerfile`](./deploy/Dockerfile) | The image: `workerd` + `curl` on `debian:bookworm-slim`, the Worker bundle, the asset Worker and the built PWA. |
| [`deploy/config.capnp`](./deploy/config.capnp) | The hand-maintained `workerd` config: Durable Object storage on the `/data` volume, the environment bindings, and the outbound `deny` rules. |
| [`deploy/compose.yml`](./deploy/compose.yml) | The stack. `COMPOSE_PROFILES=caddy` (the default) terminates TLS for `DOMAIN`; `COMPOSE_PROFILES=tunnel` runs `cloudflared` instead and publishes no port. |
| [`deploy/.env.example`](./deploy/.env.example) | Every setting, with what it does. |
| [`deploy/wrangler.jsonc`](./deploy/wrangler.jsonc) | The Cloudflare side of the same bundle. |
| [`deploy/release/`](./deploy/release) | What the Cloudflare release file ships: the config template, the deploy script, `.env.example` and its README. |

Operating notes:

- **No backups.** The volume holds live Games only, each deleted within 24 h of
  being created. There is nothing on it worth restoring.
- **`uniqueKey` in `config.capnp` must never change** — it names the directory
  every Game's SQLite file lives in.
- Updates are `make pull` then `make up`; `make health` reports the running
  version and protocol. The target is **single-instance by design**, and every
  restart drops sockets — clients reconnect and are handed a snapshot.
- `workerd`'s on-disk Durable Object storage is experimental, so its version is
  pinned exactly (`WORKERD_VERSION` in the Dockerfile) and changed only through a
  release. `server/deploy.test.ts` keeps that pin equal to the `workerd` the test
  suite runs on, and checks `config.capnp` against `deploy/wrangler.jsonc`.

### On Cloudflare

Cloudflare runs the same Worker with Workers Static Assets serving the PWA and the
`GameRoom` class backed by Durable Object SQLite, on a **Workers Custom Domain**
(`workers_dev` and preview URLs are off). **Nothing in GitHub deploys to
Cloudflare** — no `wrangler deploy` in Actions, no Cloudflare tokens in repo
secrets ([ADR-0008](./docs/adr/0008-no-cloudflare-deploys-from-github.md)).

A deploy happens from the deployer's own machine, out of the release file
published with every tag:

```bash
tar -xzf manhunt-cloudflare-v0.2.0.tar.gz && cd manhunt-cloudflare-v0.2.0
cp .env.example .env      # account id, domain, optional VAPID_SUBJECT
./deploy.sh               # renders the config, deploys, verifies /health
```

The files it is built from live in [`deploy/release/`](./deploy/release); the whole
procedure, including the VAPID keys and what a rollback may go back to, is in
[`docs/operations.md`](./docs/operations.md).

Typical use is a few private games a week — well inside the free plan. Once a
daily limit is hit, requests fail until 00:00 UTC and the client says so plainly.

### HTTPS & WebSockets (Caddy)

On the Docker target, **Caddy** ([`deploy/Caddyfile`](./deploy/Caddyfile)) fronts
`workerd` and gives you HTTPS with **no manual certificates**:

- **TLS is automatic.** Caddy provisions and renews a certificate for `$DOMAIN` —
  an ACME cert from Let's Encrypt/ZeroSSL for a real public domain, or a cert
  from its own internal CA for `localhost`/loopback. HTTP on `:80` is redirected
  to HTTPS on `:443`.
- **WebSockets just work.** `reverse_proxy` upgrades `Upgrade: websocket`
  requests into a transparent bidirectional tunnel, so live position updates flow
  over the same HTTPS origin.
- **`Host` is passed through**, so the backend's `Origin` check sees the real
  origin and `PUBLIC_ORIGIN` normally stays unset. Set it only if the proxy in
  front rewrites `Host`.

Point `DOMAIN` at your host in `deploy/.env` and make sure its DNS `A`/`AAAA`
record resolves to the machine (ports `80` and `443` reachable) so ACME can issue
the certificate. `COMPOSE_PROFILES=tunnel` swaps Caddy for a Cloudflare Tunnel
that dials out instead, publishing no port at all.

## Release

Tag a version and the `release` workflow
([`.github/workflows/release.yml`](./.github/workflows/release.yml)) builds both
targets from that one commit, plays a real Game against each of them, and only
then publishes anything:

```bash
git tag v0.2.0 && git push --tags
```

| Published | What it is |
| --- | --- |
| `manhunt-cloudflare-v0.2.0.tar.gz` | The **Cloudflare release file**: the Worker bundle, the built PWA, a Wrangler config template with no account id or domain, a deploy script and its own README. |
| `ghcr.io/sschorer/manhunt:0.2.0` | The **image** for the self-hosted target; `:latest` moves only for a final release. |
| `SHA256SUMS` + attestations | For both artifacts — `sha256sum --check` and `gh attestation verify`. |

The two checks that gate publishing are the same ones you can run yourself:
`npm run test:release` unpacks the release file, renders its Wrangler config with
its own deploy script, runs the bundle on `wrangler dev` and plays a Game against
it; `npm run test:docker` does the same against the image and then replaces the
container. Either one failing leaves the tag with no release and no image.

The release notes carry the changelog, the deploy commands for both targets, the
**protocol and snapshot versions**, and whether rolling back is safe. Tags
containing a hyphen (e.g. `v0.2.0-rc.1`) are marked as pre-releases.

Operating either target, cutting a release and rolling one back are covered in
[`docs/operations.md`](./docs/operations.md).

The workflow authenticates to GHCR with the built-in `GITHUB_TOKEN` (no secret to
configure) and signs its attestations with the workflow's own OIDC identity. It
holds **no Cloudflare credential of any kind**.

On the host: `make pull && make up`.

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
  what `make pull` on a deploy host expects.
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
commit secrets — configuration is via Worker variables and Cloudflare secrets, or
`deploy/.env` (not committed).

## License

MIT — see [`LICENSE`](./LICENSE).
