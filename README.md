# Manhunt

A web-based, GPS-driven hide-and-seek game. Players split into **hunters** and
**hiders** and play a real-world game over a bounded area. Each player runs the
app on their phone; an authoritative server tracks positions and enforces the
rules in real time.

## Status

Early scaffold. The repository ships infrastructure (Docker image, CI release
pipeline, reverse proxy) and a **static design preview** served from `public/`.
The real PWA client and the game server are tracked in the backlog — see
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

## Quickstart (local preview)

```bash
cp .env.example .env      # then edit secrets
docker compose up -d      # serves the preview + server on :3000 (behind Caddy on :443)
```

The design preview is a compiled snapshot in `public/index.html`; the editable
source mockup reference is `docs/mockup/`.

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
