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

- **Client** — React + Vite PWA, MapLibre GL map, `watchPosition` GPS, Screen Wake Lock.
- **Server** — Node.js + Socket.IO, authoritative game logic (catches, boundary, pings, wins).
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

Open http://localhost:5173 during development. Build and preview the production
bundle (served by the server itself) with:

```bash
npm run build        # builds the client into ./dist
npm start            # server on :3000, serving ./dist and the socket
```

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

## Quickstart (Docker)

```bash
cp .env.example .env      # then edit secrets
docker compose up -d      # builds the client, serves it + the server on :3000 (behind Caddy on :443)
```

A compiled static design preview still lives in `public/index.html` (with the
editable source mockup in `docs/mockup/`); the server serves the built client
from `dist/` when present and falls back to `public/` otherwise.

## Release

Tag a version and the `release` workflow (`.github/workflows/release.yml`) does two things:

1. Builds and pushes the container image to GHCR (`:<version>` and `:latest`).
2. Creates a GitHub Release for the tag, with a changelog generated from your
   Conventional Commits (grouped into Features / Bug fixes / etc.) and the image
   pull command. Tags containing a hyphen (e.g. `v0.2.0-rc.1`) are marked as
   pre-releases automatically.

```bash
git tag v0.1.0 && git push --tags
```

On the server: `docker compose pull && docker compose up -d`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The repository is public; never
commit secrets — configuration is via environment (`.env`, not committed).

## License

MIT — see [`LICENSE`](./LICENSE).
