# Manhunt — Architecture documentation (arc42)

> Documented using the [arc42](https://arc42.org) template. This lives in the
> repository at `docs/arc42.md` and is the single source of truth for the
> system architecture. Keep it updated alongside significant changes.
>
> **Target architecture for `v0.2.0`.** This document describes the architecture
> decided in [the Cloudflare and Docker migration spec](specs/cloudflare-and-docker-migration.md).
> Until the migration's cutover phase, the code on `master` still contains the
> previous Node/Socket.IO server with Redis and PostgreSQL.

---

## 1. Introduction and goals

Manhunt is a web-based, GPS-driven hide-and-seek game. Players split into
**Hunters** and **Hiders** and play a real-world Game within a Boundary. Each
player runs the app on their phone; the server tracks positions and enforces the
rules.

### Quality goals

| Priority | Goal | Motivation |
|----------|------|------------|
| 1 | **Fairness / authority** | Game outcomes (Catches, Boundary, wins) must be decided by the server, never trusted from clients, or the game is trivially cheatable. |
| 2 | **Real-time responsiveness** | Position and event updates must feel live (≤ a few seconds of lag) for the game to be fun. |
| 3 | **Mobile resilience** | The app must keep tracking on real phones with imperfect signal, backgrounding, and battery pressure. |
| 4 | **Deploy anywhere, for free** | The same release runs on Cloudflare's free plan or on a single Docker host, with full feature parity. |

### Stakeholders

| Role | Concern |
|------|---------|
| Player | Fun, fair, responsive game; join with just a Join code and a name. |
| Host | Create and start a Game. |
| Operator | Deploy and upgrade a Cloudflare or Docker installation from a GitHub release. |
| Contributor | Understand the system to extend it; the repo is public. |

---

## 2. Architecture constraints

- **Web only, no native app.** Distribution is via an installable PWA; no app-store presence.
- **Secure context required.** The browser Geolocation and Wake Lock APIs only work over HTTPS, so TLS is mandatory end to end (HTTPS + WSS).
- **Two targets from one codebase.** Cloudflare Workers and Durable Objects on the **free plan**, and a self-hosted Docker image. Both run the same Worker bundle ([ADR-0005](adr/0005-one-workers-runtime-for-cloudflare-and-docker.md)).
- **Free-plan budget.** Per-request CPU limits (10 ms in a Worker) and daily quotas (for example 100,000 Durable Object SQLite row writes per day) shape the design. Positions are never persisted, and CPU-heavy work such as Web Push runs inside Durable Objects.
- **Public repository.** No secrets in the codebase or history; configuration via environment and Cloudflare secrets. **Nothing in GitHub deploys to Cloudflare** ([ADR-0008](adr/0008-no-cloudflare-deploys-from-github.md)).
- **Position update cadence fixed at 5–10 seconds** as a deliberate battery/traffic/latency trade-off.

---

## 3. Context and scope

### Business context

The system sits between players' phones and a few external services.

| Neighbour | Direction | Exchanged |
|-----------|-----------|-----------|
| Player (browser/PWA) | in/out | Position updates, game actions ↔ filtered game state, alerts |
| Map tile provider (Mapbox / MapTiler) | out | Map tile requests |
| Web Push services (FCM, Mozilla, Apple, Windows) | out | Encrypted event notifications |
| GitHub releases / GHCR | in (deploy) | Cloudflare release file, container image |

### Technical context

- Client ↔ backend over **HTTPS** for the app, `POST /api/games`, `POST /api/games/join`, `DELETE /api/games/:gameId/seat`, `/health` and the VAPID public key.
- Client ↔ backend over **one WebSocket per Game** (`/ws/games/:gameId?v=<protocol>`) carrying JSON event, request and reply frames.
- Backend ↔ **Durable Object SQLite** for each Game's durable snapshot. There is no Redis, PostgreSQL or D1.
- Backend → **Web Push services** via `fetch`, limited to an allowlist of the four push services.

---

## 4. Solution strategy

| Decision | Approach |
|----------|----------|
| Runtime | One Worker plus Durable Objects. Cloudflare runs it directly; Docker runs the same bundle on pinned `workerd`. Web standards only. |
| Game state | One `GameRoom` Durable Object per Game, addressed by `idFromName(joinCode)`. |
| Game logic | A platform-free game core: `apply(command, now) → effects`, `nextDeadline()`, `snapshot()`. Thin host modules execute effects. |
| Real-time transport | Plain WebSockets with a small JSON protocol (events, request/reply), `partysocket` reconnect, snapshot on reconnect, close codes `4001`–`4004`. |
| Identity | No accounts. A per-game **Seat** cookie (`HttpOnly; Secure; SameSite=Strict`) is checked with `Origin` at WebSocket upgrade ([ADR-0007](adr/0007-no-accounts-in-v0-2.md)). |
| Storage | One versioned JSON snapshot row per Game; positions in memory only; games deleted within 24 h ([ADR-0006](adr/0006-durable-object-sqlite-per-game.md)). |
| Client | React + Vite PWA, MapLibre GL, `watchPosition` for GPS, Screen Wake Lock, served as static assets from the same origin. |
| Delivery | One build per `v*` tag → GHCR image and a prebuilt Cloudflare release file; deployed by operators from their own machines. |

---

## 5. Building block view

### Level 1 — system overview

- **Client (PWA)** — renders the map, captures GPS, sends actions over its Game's WebSocket, applies the server's filtered state, and shows last-known positions while reconnecting.
- **Worker entry** — HTTP routes (create, join, clear Seat, health, VAPID key), the seat cookie and `Origin` check, and routing each WebSocket to its Game's Durable Object. On Cloudflare, Workers Static Assets serve the PWA; on Docker, a small asset Worker does.
- **`GameRoom` Durable Object** — one per Game: holds sockets, runs the game core, persists its snapshot, owns the Game's single alarm, and sends Web Push.
- **Reverse proxy (Docker only)** — Caddy or a Cloudflare Tunnel terminating TLS in front of `workerd`.

### Level 2 — inside a `GameRoom`

| Module | Responsibility |
|--------|----------------|
| Game core | Lobby rules, position ticks with speed plausibility, Boundary warnings and Elimination, Catch verification, Ping reveal, win conditions, Grace periods, retention deadlines, and push recipients. Platform-free; returns effects. |
| Host loop | Applies commands, sends messages to Seats by role, replies to requests, closes sockets, persists the snapshot, and sets the alarm to the core's next deadline. |
| Socket layer | Accepts hibernating WebSockets, stores each Seat and its latest position on the socket attachment, and answers `"ping"` with `"pong"` without waking the object. |
| Push sender | Encrypts and sends notifications (`@block65/webcrypto-web-push` + `fetch`), prunes gone subscriptions, and checks endpoints against the allowlist. |
| Shared protocol (`shared/`) | Frame types, message payloads, validators, close codes and protocol version, used by client and server. |

---

## 6. Runtime view

### 6.1 Creating and joining a Game

1. The Host calls `POST /api/games`. The Worker picks a random Join code and asks `idFromName(code)` to claim it, retrying on a collision.
2. Other players call `POST /api/games/join` with the Join code and a name.
3. Both responses return `{ game, playerId }` and set the Seat cookie scoped to `/ws/games/<gameId>`. The client stores `{ gameId, playerId }` in `localStorage`.
4. The client opens `/ws/games/<gameId>?v=<protocol>`. The Worker checks the Seat cookie and `Origin`, then hands the socket to the `GameRoom`, which sends a snapshot and broadcasts `lobby_update`.

### 6.2 Game tick (every 5–10 s)

1. The client sends a `position_update` event.
2. The game core validates it (including speed plausibility) and runs Boundary checks.
3. The host keeps the position in memory and on the sender's socket attachment. Positions are never written to storage.
4. The core emits a **per-role** `game_state`: Hunters don't receive Hider coordinates except during a Ping reveal. The host sends each view to the Seats with that role immediately.

### 6.3 Catch

1. A Hunter within the Catch radius sends a `claim_catch` request.
2. The game core verifies the distance from server-side positions and rejects out-of-range claims.
3. On success the Hider becomes a Hunter, `catch_confirmed` is broadcast, the snapshot is persisted, and a "You've been caught!" push goes to the caught player.

### 6.4 Ping reveal and other timers

All timers are deadlines inside the game core: the Ping reveal interval, the game-end countdown, each dropped Seat's Grace period, and retention. The host points the Durable Object's single alarm at the earliest deadline and applies `timers_due` when it fires. Deadlines are part of the snapshot, so timers survive eviction and restarts. A Ping reveal lifts the role filter for one broadcast and pushes "Hiders revealed" to the Hunters.

### 6.5 Win condition and end screen

1. The core ends the Game when the last Hider is caught (Hunters win, `all_caught`) or when the game length elapses with a Hider still free (Hiders win, `timer`).
2. It produces the summary (winner, reason, span, every Catch, each Hider's survival time), sends `game_over` to everyone, pushes "Game over", and closes all sockets with `4002`.
3. A later connection receives `game_over` again, then `4002`, until the Game is deleted 24 h after its end.

### 6.6 Web Push notifications

1. A player opts in from the Lobby: the client registers a `PushSubscription` and sends `push_subscribe`. The Game validates the endpoint (https, default port, not an IP or local host, allowlisted push service) and stores it on the player's Seat.
2. Push effects are sent **after** the same command's game messages, concurrently, with a 10 s timeout and no redirects. `404`/`410` removes the subscription; other failures are logged and never retried.
3. Each notification sets its own `ttl`, `urgency` and `topic` (caught: 1 h, high; reveal: 180 s with topic `reveal-<gameId>`; game over: 1 h).
4. Push is off unless `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and a real `VAPID_SUBJECT` are configured.

### 6.7 Reconnect and resume

1. When a phone drops signal, its socket closes. The Game treats this as `seat_dropped` and holds the Seat for the Grace period, in every phase including the Lobby.
2. The client keeps showing last-known positions and `partysocket` reconnects with backoff. The Seat cookie authenticates the new socket at upgrade.
3. The Game cancels the Seat's pending release and sends a full snapshot (game, roster, current `game_state`). Missed messages aren't replayed.
4. A newer socket for the same Seat replaces the old one (`4003`), a rejected or expired Seat gets `4001`, an ended Game gets `4002`, and an outdated client gets `4004` and reloads.

---

## 7. Deployment view

### 7.1 Cloudflare installation

- One Worker with Workers Static Assets and the `GameRoom` Durable Object class (SQLite-backed), served on a **Workers Custom Domain**. `workers_dev` and preview URLs are disabled.
- Deployed from an operator's own machine: download the Cloudflare release file from GitHub, fill in a local `.env`, run its deploy script (pinned `wrangler deploy`, verifying `/health`). VAPID keys are set with `wrangler secret put`.

### 7.2 Docker installation

- **app** — the release image: pinned `workerd` running the same Worker bundle plus an asset Worker, with Durable Object storage on a `/data` volume, a `curl` health check, and `stop_grace_period: 3s`.
- **caddy** — public :443, terminating TLS for `DOMAIN` (default). Alternatively, the `tunnel` profile runs `cloudflared`.
- Single instance by design. The volume holds only live Games (deleted within 24 h) and is not backed up. Updates with `make pull` and `make up`.

### 7.3 Release pipeline

Push a `v*` tag → GitHub Actions runs one build → CI runs the end-to-end check against the Cloudflare release file under `wrangler dev` and against the Docker image → publishes the image to GHCR and attaches `manhunt-cloudflare-vX.Y.Z.tar.gz`, `SHA256SUMS` and attestations to the GitHub release. Operators deploy each target themselves.

---

## 8. Cross-cutting concepts

### Authoritative game state

No game-affecting decision is ever taken from client input. Positions are advisory; Catches, Boundary violations, and wins are computed by the game core.

### Real-time filtering by role

The game core emits separate `game_state` views per role, so Hunters never receive Hider coordinates outside a Ping reveal. Filtering happens before anything is sent; clients cannot request hidden data.

### Platform-free game core

All rules live in a module that takes commands and the current time and returns effects. It has no platform imports, is tested with plain Vitest, and is identical on both targets.

### Geolocation and battery

`watchPosition` supplies GPS; the client throttles updates to the 5–10 s cadence. Screen Wake Lock keeps tracking alive; the client falls back to last-known positions on signal loss and reconnects automatically.

### Security

HTTPS/WSS everywhere with exactly one origin per installation. Seat cookies are `HttpOnly; Secure; SameSite=Strict` and checked together with `Origin` at WebSocket upgrade. Every inbound message is validated. Outbound push requests only reach allowlisted push services. Logs never contain positions or player names. No secrets in the repo, and no Cloudflare credentials in GitHub.

---

## 9. Architecture decisions

**ADR-001 — Server is authoritative.** All game logic runs server-side.
*Rationale:* clients are untrusted and GPS is spoofable. *Consequence:* higher
server load, but cheating is prevented.

**ADR-002 — 5–10 s position cadence.** Fixed update interval.
*Rationale:* balances live feel against battery drain and socket traffic on
city-scale play. *Consequence:* sub-second precision is not available; the
ping-reveal mechanic compensates.

**ADR-003 — Self-hosted containers, not edge.** *Superseded by
[ADR-0005](adr/0005-one-workers-runtime-for-cloudflare-and-docker.md).*

**ADR-004 — Split state: Redis + PostgreSQL.** *Superseded by
[ADR-0006](adr/0006-durable-object-sqlite-per-game.md).*

Newer decisions are recorded as files in `docs/adr/`:

- [ADR-0005 — One Workers runtime for Cloudflare and Docker](adr/0005-one-workers-runtime-for-cloudflare-and-docker.md)
- [ADR-0006 — One Durable Object with SQLite per game replaces Redis and PostgreSQL](adr/0006-durable-object-sqlite-per-game.md)
- [ADR-0007 — No accounts in v0.2](adr/0007-no-accounts-in-v0-2.md)
- [ADR-0008 — Nothing in GitHub deploys to Cloudflare](adr/0008-no-cloudflare-deploys-from-github.md)

---

## 10. Quality requirements

| Quality | Scenario | Target |
|---------|----------|--------|
| Fairness | A Hunter spoofs GPS to claim a Catch out of range. | Game core rejects; no state change. |
| Latency | A Hider moves; Hunters' relevant view updates. | Reflected within one tick (≤ ~10 s). |
| Resilience | A player briefly loses signal, or the backend restarts. | Socket reconnects within the Grace period; snapshot restores the view; timers still fire. |
| Cost | A heavy day (4 Games × 2 h × 12 players) on Cloudflare. | Fits the free plan (~31% of Durable Object duration). |
| Deployability | Operator ships a new version. | `git tag` → CI publishes both artifacts → deploy script or `make pull && make up`; `/health` reports the new version. |

---

## 11. Risks and technical debt

- **GPS spoofing** remains possible at the input layer; mitigated by server-side range and speed checks but not eliminated.
- **Battery/backgrounding on mobile** can suspend tracking; Wake Lock helps but browser behaviour varies by OS.
- **Experimental `workerd` disk storage**: pinned version; read release notes before upgrading.
- **Free-plan hard limits**: once a daily limit is hit, requests fail until 00:00 UTC; the client shows a clear message.
- **Every deploy drops sockets** on both targets; clients reconnect and receive a snapshot.
- **No accounts**: anyone with a deployment's URL can create Games; a host passphrase is the planned fallback.
- **Push allowlist**: a new browser push service needs a code change.
- **Public repo + secrets**: any secret ever committed must be rotated; enforce secret scanning.

---

## 12. Glossary

The domain glossary lives in [`server/CONTEXT.md`](../server/CONTEXT.md). Key terms:

| Term | Definition |
|------|------------|
| Game | One match, from creation through its Lobby and play until it ends. |
| Lobby | The phase of a Game before it starts. |
| Join code | The short code players enter to find and join a Game. |
| Seat | A player's place in one Game, reclaimable after a dropped connection. |
| Grace period | How long a dropped Seat is held before it is released. |
| Host | The player who created the Game. |
| Hunter / Hider | Players trying to catch / avoiding capture. |
| Ping reveal | A scheduled moment when every Hider's position is shown to the Hunters. |
| Catch / Catch radius | A Hunter's confirmed capture of a Hider / the distance within which it is valid. |
| Boundary / Elimination | The play area / removal from play for staying outside it. |
| Tick | One position-update/broadcast cycle (every 5–10 s). |
| PWA | Progressive Web App — installable, works offline-ish, no app store. |
