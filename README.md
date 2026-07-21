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

Then open <http://localhost:5173>. Migrations run automatically on the server's
first boot (`RUN_MIGRATIONS=true`); Postgres (`:5432`) and Redis (`:6379`) are
also published on `localhost` for direct inspection with `psql`/`redis-cli`.

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

### Live state (Redis)

Hot, ephemeral state — every player's latest position — lives in **Redis**, and
the **broadcaster** fans out `game_state` between server instances over Redis
pub/sub (see [`docs/arc42.md`](./docs/arc42.md) §5.2, ADR-004). A socket first
`join`s with its identity (`gameId`, `playerId`, `role`); that identity is bound
server-side, so a `position_update` carries only coordinates and can only write
its own player — a client can't spoof another. On each tick the server writes
the reported position to a per-game Redis hash and publishes the game's positions
to every instance, which emit `game_state` to their connected sockets **filtered
per recipient's role** — hunters never receive hider coordinates (the scheduled
reveal is part of the rules engine, [BACKLOG.md](./BACKLOG.md) #14). Updates
arriving faster than the tick cadence are dropped.

Point the server at Redis with `REDIS_URL` (see [`.env.example`](./.env.example);
`docker compose up` provides one). Redis is **optional in development**: with no
`REDIS_URL` the server falls back to an in-process store and loopback
broadcaster, so a single instance (and CI, which has no Redis service) runs
fully — you only need Redis to share hot state across multiple instances.

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
