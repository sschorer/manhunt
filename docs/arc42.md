# Manhunt — Architecture documentation (arc42)

> Documented using the [arc42](https://arc42.org) template. This lives in the
> repository at `docs/arc42.md` and is the single source of truth for the
> system architecture. Keep it updated alongside significant changes.

---

## 1. Introduction and goals

Manhunt is a web-based, GPS-driven hide-and-seek game. Players split into
**hunters** and **hiders** and play a real-world game over a bounded area.
Each player runs the app on their phone; the server tracks positions and
enforces the rules.

### Quality goals

| Priority | Goal | Motivation |
|----------|------|------------|
| 1 | **Fairness / authority** | Game outcomes (catches, boundary, wins) must be decided by the server, never trusted from clients, or the game is trivially cheatable. |
| 2 | **Real-time responsiveness** | Position and event updates must feel live (≤ a few seconds of lag) for the game to be fun. |
| 3 | **Mobile resilience** | The app must keep tracking on real phones with imperfect signal, backgrounding, and battery pressure. |
| 4 | **Self-hostability** | The whole system deploys as a small set of containers on a single server. |

### Stakeholders

| Role | Concern |
|------|---------|
| Player | Fun, fair, responsive game; simple join flow. |
| Game host | Configure and run a match; moderate participants. |
| Operator (repo owner) | Deploy, upgrade, and keep the service healthy on their own server. |
| Contributor | Understand the system to extend it; the repo is public. |

---

## 2. Architecture constraints

- **Web only, no native app.** Distribution is via an installable PWA; no app-store presence.
- **Secure context required.** The browser Geolocation and Wake Lock APIs only work over HTTPS, so TLS is mandatory end to end (HTTPS + WSS).
- **Self-hosted.** Runs on the operator's own server as Docker containers; no managed edge/serverless platform.
- **Public repository.** Source is public on GitHub; no secrets in the codebase or history, configuration via environment.
- **Released as a container image** built and published by CI on tag, consumed via `docker compose` on the server.
- **Position update cadence fixed at 5–10 seconds** as a deliberate battery/traffic/latency trade-off.

---

## 3. Context and scope

### Business context

The system sits between players' phones and a set of supporting services.
Inbound: player position streams and game actions. Outbound: filtered game
state, notifications, and map tiles for rendering.

| Neighbour | Direction | Exchanged |
|-----------|-----------|-----------|
| Player (browser/PWA) | in/out | Position updates, game actions ↔ filtered game state, alerts |
| Map tile provider (Mapbox / MapTiler) | out | Map tile requests |
| Web Push service | out | Event notifications |
| GitHub (GHCR) | in (deploy) | Container image pulls |

### Technical context

- Client ↔ server over **WebSocket (WSS)** for the live game loop, plus HTTPS for static assets and REST-ish endpoints (auth, history).
- Server ↔ **Redis** for live/ephemeral state and pub/sub between instances.
- Server ↔ **PostgreSQL** for durable data (accounts, games, players, events, optional position history for replays).

---

## 4. Solution strategy

| Decision | Approach |
|----------|----------|
| Real-time transport | Node.js + Socket.IO with one room per game. |
| Authority | Server is the single source of truth; all catch/boundary/win logic runs server-side from reported positions. |
| Client | React + Vite PWA, MapLibre GL for maps, `watchPosition` for GPS, Screen Wake Lock to keep tracking alive. |
| State split | Hot/ephemeral live state in Redis; durable records in PostgreSQL. |
| Delivery | Multi-stage Docker image built and pushed to GHCR by GitHub Actions on a version tag; deployed via `docker compose` behind Caddy for automatic TLS and WebSocket upgrades. |

---

## 5. Building block view

### Level 1 — system overview

- **Client (PWA)** — renders the map, captures GPS, sends actions, applies the server's filtered state.
- **Game server** — authoritative Node/Socket.IO process: session/room management, the tick loop, rule enforcement, and REST endpoints. It also serves the built PWA client (static `dist/`, with an SPA fallback) on the same origin and exposes a `/health` probe.
- **Redis** — live positions, current room state, pub/sub fan-out.
- **PostgreSQL** — accounts, games, players, event log, position history.
- **Caddy** — reverse proxy terminating TLS and upgrading WebSocket connections.

### Level 2 — inside the game server

| Component | Responsibility |
|-----------|----------------|
| Auth / accounts | Sign-in, sessions, account lifecycle. |
| Lobby manager | Room creation, join codes, role assignment, ready/start. |
| Tick engine | Ingests `position_update`, validates, writes to Redis. |
| Rules engine | Boundary checks, catch-radius detection, ping scheduling, win conditions. |
| Broadcaster | Emits per-role filtered `game_state` to each room. |
| Persistence | Flushes events (and optional positions) to PostgreSQL. |

---

## 6. Runtime view

### 6.1 Game tick (every 5–10 s)

1. Client emits `position_update`.
2. Server validates the payload and writes the position to Redis.
3. Rules engine runs boundary, catch-radius, and ping-timer checks.
4. Broadcaster emits a **per-role filtered** `game_state` to the room — hunters do not receive hider coordinates except during a scheduled ping reveal.
5. Clients render the map and any proximity alerts.
6. Repeat on the next tick.

### 6.2 Catch

1. Hunter within catch radius emits `claim_catch` (or scans the hider's code).
2. Server verifies the distance server-side; rejects if out of range.
3. On success it writes a `catch` event, switches the hider's role, and broadcasts `catch_confirmed`.

### 6.3 Joining a game

1. Player authenticates.
2. Player enters a room code → lobby manager adds them → `lobby_update` broadcast.

### 6.4 Ping reveal

On the configured interval the rules engine forces each hider's position into the next broadcast so hunters get a periodic fix, preventing camping.

---

## 7. Deployment view

Single server running Docker containers:

- **caddy** — public :443, terminates TLS, proxies to the app, upgrades WebSocket.
- **app** — the game server image from `ghcr.io/<owner>/manhunt`; also serves the built client bundle and a `/health` endpoint used by the container healthcheck and the reverse proxy.
- **db** — PostgreSQL with a persistent volume.
- **redis** — in-memory store (optionally persisted).

Release pipeline: push a `v*` tag → GitHub Actions builds the multi-stage image and pushes `:<version>` and `:latest` to GHCR → operator runs `docker compose pull && docker compose up -d` (optionally automated with Watchtower).

Secrets (DB password, push VAPID keys, session secret) are provided via environment / a `.env` file that is **not** committed, since the repo is public.

---

## 8. Cross-cutting concepts

### Authoritative game state

No game-affecting decision is ever taken from client input. Positions are advisory; catches, boundary violations, and wins are computed server-side.

### Real-time filtering by role

A single broadcast path applies role-based visibility so hunters never receive hider coordinates outside a ping reveal. Filtering happens on the server before emit — clients cannot request hidden data.

### Geolocation and battery

`watchPosition` supplies GPS; the client throttles emits to the 5–10 s cadence. Screen Wake Lock keeps tracking alive; the client degrades gracefully to last-known position on signal loss and reconnects the socket automatically.

### Security

HTTPS/WSS everywhere; no secrets in the repo; configuration via environment; least-privilege DB credentials; server-side validation of every inbound message.

---

## 9. Architecture decisions

**ADR-001 — Server is authoritative.** All game logic runs server-side.
*Rationale:* clients are untrusted and GPS is spoofable. *Consequence:* higher
server load, but cheating is prevented.

**ADR-002 — 5–10 s position cadence.** Fixed update interval.
*Rationale:* balances live feel against battery drain and socket traffic on
city-scale play. *Consequence:* sub-second precision is not available; the
ping-reveal mechanic compensates.

**ADR-003 — Self-hosted containers, not edge.** Node/Socket.IO in Docker
rather than a managed edge platform. *Rationale:* operator wants full control
and a public, reproducible release. *Consequence:* the operator owns TLS,
scaling, and uptime (mitigated by Caddy + compose).

**ADR-004 — Split state: Redis + PostgreSQL.** *Rationale:* live positions are
hot and ephemeral; accounts/history are durable. *Consequence:* two
stores to operate.

---

## 10. Quality requirements

| Quality | Scenario | Target |
|---------|----------|--------|
| Fairness | A hunter spoofs GPS to claim a catch out of range. | Server rejects; no state change. |
| Latency | A hider moves; hunters' relevant view updates. | Reflected within one tick (≤ ~10 s). |
| Resilience | A player briefly loses signal. | Socket auto-reconnects; last-known position shown; no crash. |
| Deployability | Operator ships a new version. | `git tag` → CI publishes image → `compose pull && up -d`. |

---

## 11. Risks and technical debt

- **GPS spoofing** remains possible at the input layer; mitigated by server-side range checks but not eliminated. Consider plausibility checks (implausible speed/teleport detection).
- **Battery/backgrounding on mobile** can suspend tracking; Wake Lock helps but browser behaviour varies by OS.
- **Public repo + secrets**: any secret ever committed must be rotated; enforce secret scanning.
- **Single-server deployment** is a single point of failure; no HA in the initial design.
- **Position history growth**: storing every position for replays is high-volume; needs retention limits.

---

## 12. Glossary

| Term | Definition |
|------|------------|
| Hunter | Player trying to catch hiders. |
| Hider | Player avoiding capture. |
| Ping reveal | Scheduled forced disclosure of hider positions to hunters. |
| Catch radius | Server-side distance threshold within which a catch is valid. |
| Boundary | Geofenced play area; leaving it triggers a warning or elimination. |
| Tick | One position-update/broadcast cycle (every 5–10 s). |
| PWA | Progressive Web App — installable, works offline-ish, no app store. |
