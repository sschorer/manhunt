#!/usr/bin/env bash
# Creates labels, milestones, and the backlog issues for this repo.
# Requires the GitHub CLI (https://cli.github.com), authenticated: `gh auth login`.
# Run from the repo root AFTER the repo exists on GitHub and a remote is set:
#   ./scripts/create-issues.sh
set -euo pipefail

echo "==> Creating labels"
label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null; }
label "type:infra"    "5319e7" "Infrastructure / tooling"
label "type:feature"  "1d76db" "New functionality"
label "area:client"   "0e8a16" "Frontend / PWA"
label "area:server"   "b60205" "Backend / game server"
label "area:infra"    "fbca04" "Deploy / CI / ops"
label "priority:high" "d93f0b" "High priority"
label "priority:med"  "fef2c0" "Medium priority"
label "priority:low"  "c5def5" "Low priority"
label "blocked"       "000000" "Blocked / needs input"

echo "==> Creating milestones"
milestone() {
  gh api "repos/{owner}/{repo}/milestones" -f title="$1" -f state=open >/dev/null 2>&1 \
    || echo "   (milestone '$1' already exists)"
}
milestone "M1 – Foundation"
milestone "M2 – Core game loop"
milestone "M3 – Trust, PWA & polish"

echo "==> Creating issues"
issue() { # title  body  milestone  labels(csv)
  gh issue create --title "$1" --body "$2" --milestone "$3" --label "$4" >/dev/null
  echo "   + $1"
}

M1="M1 – Foundation"; M2="M2 – Core game loop"; M3="M3 – Trust, PWA & polish"

issue "Scaffold client + server" \
"Set up the Vite + React PWA client and the Node/Socket.IO server with shared dev tooling.

**Acceptance**
- \`npm run dev\` runs the server; client dev server runs and proxies the socket
- \`npm run build\` produces \`dist/\`; Dockerfile switched to copy \`dist/\`
- Health check at \`/health\`" \
"$M1" "type:infra,area:client,area:server,priority:high"

issue "Database schema + migrations" \
"Introduce migration tooling and formalize \`db/schema.sql\` (accounts, vouches, games, players, events, positions).

**Acceptance**
- Migrations run on boot or via a command
- Schema matches docs/arc42.md §5" \
"$M1" "type:infra,area:server,priority:high"

issue "Redis integration for live state + pub/sub" \
"Wire Redis for hot position/state and cross-instance pub/sub.

**Acceptance**
- Positions written to Redis on each tick
- Broadcaster fans out via pub/sub" \
"$M1" "type:infra,area:server,priority:high"

issue "CI: build & push image to GHCR on tag" \
"Validate the release workflow end to end.

**Acceptance**
- Pushing a \`v*\` tag publishes \`:<version>\` and \`:latest\`
- GHCR package visibility set (public or pull token documented)" \
"$M1" "type:infra,area:infra,priority:med"

issue "Caddy TLS + WebSocket upgrade" \
"Serve over HTTPS with automatic TLS and WSS via Caddy.

**Acceptance**
- App reachable at \$DOMAIN over HTTPS
- WebSocket upgrades succeed through the proxy" \
"$M1" "type:infra,area:infra,priority:med"

issue "Lobby: create/join room, roles, ready, start" \
"Room lifecycle with join codes and role assignment.

**Acceptance**
- Create game returns a room code
- Join by code; assign hunter/hider; ready-up; host starts" \
"$M2" "type:feature,area:client,area:server,priority:high"

issue "Define WebSocket message contract" \
"Specify and implement: join, position_update, claim_catch, game_state, catch_confirmed, lobby_update.

**Acceptance**
- Documented event schemas
- Server validates every inbound payload" \
"$M2" "type:feature,area:server,priority:high"

issue "Client GPS capture (watchPosition + Wake Lock)" \
"Capture GPS and emit on the fixed cadence.

**Acceptance**
- \`watchPosition\` throttled to 5–10s
- Screen Wake Lock keeps tracking alive; graceful fallback on denial" \
"$M2" "type:feature,area:client,priority:high"

issue "Map rendering with pins + boundary" \
"MapLibre GL map with player pins and the play-area boundary.

**Acceptance**
- Map renders on mobile
- Own position + permitted others shown; boundary overlaid" \
"$M2" "type:feature,area:client,priority:high"

issue "Authoritative tick engine" \
"Ingest, validate, and store positions server-side each tick.

**Acceptance**
- Invalid/implausible payloads rejected
- Latest positions available to the rules engine" \
"$M2" "type:feature,area:server,priority:high"

issue "Boundary enforcement" \
"Geofence checks against the play area.

**Acceptance**
- Leaving the boundary warns, then eliminates per config" \
"$M2" "type:feature,area:server,priority:med"

issue "Catch detection + role switch" \
"Server-side distance check on claim_catch; convert caught hider to hunter.

**Acceptance**
- Out-of-range claims rejected
- Successful catch emits catch_confirmed and flips role" \
"$M2" "type:feature,area:server,priority:high"

issue "Ping-reveal scheduler" \
"Periodically force hider positions into the broadcast.

**Acceptance**
- Configurable interval
- Hiders revealed to hunters only on reveal ticks" \
"$M2" "type:feature,area:server,priority:med"

issue "Per-role state filtering" \
"Filter game_state by role before emit.

**Acceptance**
- Hunters never receive hider coordinates outside a reveal
- Verified from raw socket traffic" \
"$M2" "type:feature,area:server,priority:high"

issue "Win conditions + end screen data" \
"Detect end (last hider / survive timer) and produce a summary.

**Acceptance**
- Correct winner determination
- Summary payload (survival times, catches)" \
"$M2" "type:feature,area:server,priority:med"

issue "Join screen" \
"Enter room code, create or join a game." \
"$M2" "type:feature,area:client,priority:med"

issue "Lobby screen" \
"Hunters/hiders lists, room code chip, ready control." \
"$M2" "type:feature,area:client,priority:med"

issue "In-game map screen (hunter + hider)" \
"Map view with proximity alerts, timer, and reveal countdown; role-specific rendering." \
"$M2" "type:feature,area:client,priority:high"

issue "Game over screen" \
"Survival time, catches, replay/rematch actions." \
"$M2" "type:feature,area:client,priority:med"

issue "Account auth + sessions + root bootstrap" \
"Sign-in, sessions, and a trusted root account seed.

**Acceptance**
- Authenticated sessions
- Root account exists and can vouch" \
"$M3" "type:feature,area:server,priority:high"

issue "Vouch system (align with darkroom)" \
"Model, promotion rule, and access gate for the web-of-trust vouch system.

**Blocked:** reconcile thresholds/penalties/revocation with the \`darkroom\` repo before finalizing (docs/arc42.md §8, ADR-005).

**Acceptance**
- Unvouched users blocked from create/join
- Promotion rule matches darkroom" \
"$M3" "type:feature,area:server,priority:high,blocked"

issue "PWA install (manifest + service worker)" \
"Make the client installable with an offline shell." \
"$M3" "type:feature,area:client,priority:med"

issue "Web Push notifications" \
"Push key game events (caught, reveal, time) via VAPID." \
"$M3" "type:feature,area:client,area:server,priority:med"

issue "Reconnect handling + last-known position" \
"Auto-reconnect the socket and show last-known position on signal loss." \
"$M3" "type:feature,area:client,area:server,priority:med"

issue "Replay from position history" \
"Animate player movement from stored positions after a match." \
"$M3" "type:feature,area:client,area:server,priority:low"

issue "Anti-cheat: implausible-speed detection" \
"Reject teleport/implausible-speed position updates at the input layer." \
"$M3" "type:feature,area:server,priority:low"

issue "Configurable game settings" \
"Expose catch radius, ping interval, boundary, and duration in game config." \
"$M3" "type:feature,area:client,area:server,priority:med"

echo "==> Done. Created 27 issues across 3 milestones."
