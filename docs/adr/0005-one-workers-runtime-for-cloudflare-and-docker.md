---
status: accepted (supersedes ADR-003 in docs/arc42.md)
---

# One Workers runtime for Cloudflare and Docker

Manhunt must run on Cloudflare's free plan and on any Docker host from one TypeScript codebase. We write the backend once as a Worker plus Durable Objects. Cloudflare runs it directly, and the Docker image runs the same bundle on a pinned `workerd`. A spike showed that data, alarms and hibernating WebSockets survive container restarts.

## Considered Options

- **Shared core with a Node adapter:** rejected. It would be a second implementation of sockets, hibernation, alarms, per-game isolation and storage, which is exactly where the two targets would drift apart.
- **Miniflare on Node for Docker:** rejected. Miniflare describes itself as a development and testing simulator.

## Consequences

- **Docker is single-instance:** workerd keeps Durable Objects on one instance.
- **Hand-maintained config:** the Docker target has a hand-written `config.capnp` next to `wrangler.jsonc`, and a CI end-to-end check against the image catches drift.
- **Version pinning:** workerd's on-disk storage is experimental, so the version is pinned and changes only through a release.
- **Redeploys drop sockets:** every restart drops them on both targets, and clients reconnect. workerd waits on open sockets instead of exiting on SIGTERM, so compose uses a short `stop_grace_period`.
- **Web standards only:** the backend uses no `nodejs_compat`.
- **Seams:** platform-free game logic sits behind a small core interface; only thin host modules touch the platform.
