# Backlog

Grouped into three milestones. These map 1:1 to the GitHub issues created by
`scripts/create-issues.sh`. Priorities: 🔴 high · 🟡 med · ⚪ low.

## M1 — Foundation

1. 🔴 **Scaffold client + server** — Vite + React PWA client and Node/Socket.IO server, shared dev tooling. *(area: client, server)*
2. 🔴 **Database schema + migrations** — accounts, vouches, games, players, events, positions; migration tooling. *(area: server)*
3. 🔴 **Redis integration** — live position/state store + pub/sub fan-out between instances. *(area: server)*
4. 🟡 **CI: build & push image to GHCR on tag** — verify `release.yml`, package visibility, cache. *(area: infra)*
5. 🟡 **Caddy TLS + WebSocket upgrade** — reverse proxy in compose, HTTPS/WSS end to end. *(area: infra)*

## M2 — Core game loop

6. 🔴 **Lobby** — create/join room by code, role assignment, ready-up, start. *(area: client, server)*
7. 🔴 **WebSocket contract** — `join`, `position_update`, `claim_catch`, `game_state`, `catch_confirmed`, `lobby_update`. *(area: server)*
8. 🔴 **Client GPS capture** — `watchPosition`, throttle to 5–10s cadence, Screen Wake Lock. *(area: client)*
9. 🔴 **Map rendering** — MapLibre GL map with player pins and boundary overlay. *(area: client)*
10. 🔴 **Authoritative tick engine** — validate inbound positions, write to Redis. *(area: server)*
11. 🟡 **Boundary enforcement** — geofence checks; warn or eliminate on exit. *(area: server)*
12. 🔴 **Catch detection + role switch** — server-side distance check, convert caught hider to hunter. *(area: server)*
13. 🟡 **Ping-reveal scheduler** — periodically force hider positions into the broadcast. *(area: server)*
14. 🔴 **Per-role state filtering** — hunters never receive hider coordinates except on ping reveal. *(area: server)*
15. 🟡 **Win conditions + end screen** — last hider / survive-the-timer, produce summary. *(area: server)*

## M2 — Client screens (from the mockup)

16. 🟡 **Join screen** — enter room code, create/join. *(area: client)*
17. 🟡 **Lobby screen** — hunters/hiders list, room code chip, ready. *(area: client)*
18. 🔴 **In-game map screen** — hunter + hider views, proximity alerts, timer, reveal countdown. *(area: client)*
19. 🟡 **Game over screen** — survival time, catches, replay/rematch actions. *(area: client)*

## M3 — Trust, PWA & polish

20. 🔴 **Account auth + sessions** — sign-in, sessions, root bootstrap. *(area: server)*
22. 🟡 **PWA install** — manifest + service worker, installable, offline shell. *(area: client)*
23. 🟡 **Web Push notifications** — event pushes (caught, reveal, time). *(area: client, server)*
24. 🟡 **Reconnect handling** — socket auto-reconnect, last-known position on signal loss. *(area: client, server)*
25. ⚪ **Replay** — animate movement from position history. *(area: client, server)*
26. ⚪ **Anti-cheat** — implausible-speed / teleport detection at the input layer. *(area: server)*
27. 🟡 **Configurable game settings** — catch radius, ping interval, boundary, duration. *(area: client, server)*
