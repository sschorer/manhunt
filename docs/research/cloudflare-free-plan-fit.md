# Does Manhunt's load fit the Cloudflare free plan?

Research for issue #55 (map #53). Researched 2026-09-13 against Cloudflare's developer docs; each page's "last updated" date is noted in [Sources](#sources).

## Verdict

**Yes, with room to spare, provided we don't write every position tick to SQLite.** A worst-case day (4 two-hour, 12-player games at a 5 s cadence, all on the same day) uses about **31 % of Durable Object duration**, **~6 % of DO requests** (or **~72 %** if the 20:1 WebSocket discount doesn't apply to the free quota, see below), **~1.4 % of Workers requests**, and almost none of D1. Serving the frontend as static assets is free and unlimited.

The one limit that breaks is **SQLite rows written (100,000/day)**, and only if the DO saves each `position_update` to storage. Doing that with an index costs 2–4 rows per tick, so one busy day needs **138–276 %** of the quota. Keep live positions in the Durable Object's memory (as today's hot store does in Redis or in-process) and persist only events and occasional snapshots. That keeps rows written at about 2 %.

**Which limit binds first** (with in-memory positions):

- If the 20:1 ratio applies to the free request quota: **DO duration**, at about **29 game-hours per day** (13,000 GB-s ÷ 0.125 GB ÷ 3,600 s), whatever the player count.
- If it doesn't (treated as 1:1): **DO requests**, at about **11.6 game-hours per day** of 12-player, 5 s play.

A realistic week (2–4 games, one per day) uses 6–8 % of any daily limit, which is **12–15× headroom**. The worst day above still has **1.4× headroom** under the pessimistic 1:1 reading and **3.2×** otherwise.

## Free plan limits (current)

| Product | Limit (Free plan) | Value | Source |
|---|---|---|---|
| Workers | Requests | 100,000 / day, reset 00:00 UTC; over the limit, Error 1027 (fail open or fail closed is configurable) | [W-limits], [W-pricing] |
| Workers | CPU time | 10 ms per HTTP request / Cron invocation (waiting on I/O doesn't count) | [W-limits] |
| Workers | Memory / subrequests | 128 MB / 50 per request | [W-limits] |
| Workers | WebSockets | Opening a connection counts as a request; "WebSocket messages routed through a Worker do not count as requests" | [W-pricing] |
| Static assets | Requests | "free and unlimited"; not counted against Workers requests. Routes matched by `run_worker_first` do invoke the Worker and get a 429 once over the limit | [SA-billing] |
| Static assets | Files | 20,000 files per version, 25 MiB per file | [W-limits] |
| Durable Objects | Storage backend | "Only Durable Objects with SQLite storage backend are available" on Free | [DO-pricing] |
| Durable Objects | Requests | 100,000 / day. Counts HTTP, RPC, WebSocket messages and alarm invocations; each WebSocket connection needs a request | [DO-pricing] |
| Durable Objects | WebSocket message billing | "For compute requests billing-only, a 20:1 ratio is applied to incoming WebSocket messages". "No charge for outgoing WebSocket messages, nor for incoming WebSocket protocol pings" | [DO-pricing] |
| Durable Objects | Duration | 13,000 GB-s / day, always billed at the full 128 MB. Billed "while the Durable Object is actively running or is idle in memory but unable to hibernate". Plain `accept()` bills for the whole time a socket is connected | [DO-pricing] |
| Durable Objects | Hibernation | No duration billed while hibernated. Hibernation is blocked by alarms, incoming messages, `setTimeout`/`setInterval`. Auto ping/pong doesn't wake the object | [DO-websockets] |
| Durable Objects | CPU | 30 s per invocation (HTTP request, WebSocket message, alarm); each new request resets it | [DO-limits] |
| DO SQLite | Rows read / written / stored | 5,000,000 / day, 100,000 / day, 5 GB total. "Every row update of an index counts as an additional row"; each `setAlarm()` is one row written | [DO-pricing], [DO-sql] |
| DO (all) | Over the limit | "If you exceed any one of the free tier limits, further operations of that type will fail with an error." "Daily free limits reset at 00:00 UTC." | [DO-pricing] |
| D1 | Rows read / written / storage | 5,000,000 / day, 100,000 / day, 5 GB total; reset 00:00 UTC; queries fail once over the limit | [D1-pricing] |

Note: the DO FAQ still says "1 GB on the Free plan" for storage, which conflicts with the 5 GB on the newer pricing and limits pages. Manhunt's data is tiny, so it doesn't matter here.

## What one tick costs today (from the code)

Grounded in `server/app.ts` and `server/live/*` at `ec52d04`:

- **Inbound per tick: 1 message.** `position_update` is fire-and-forget with no ack (`server/app.ts`, `socket.on('position_update')`).
- **Storage per tick: 1 read of the game's whole snapshot plus 1 write.** `createTickEngine.ingest` calls `store.readPositions(gameId)` (N rows), then `store.writePosition` (`server/live/tick.ts`).
- **Outbound per tick: N messages.** `broadcaster.publish` → `fanOut` emits one role-filtered `game_state` to every socket in the room (`server/app.ts`, `fanOut`). A boundary change adds 1 personal or room message, but only when the state changes.
- **Ping reveal: 1 timer, N outbound messages, and pushes to the hunters,** every `PING_INTERVAL_S` (default 180 s) (`revealPing`).
- **Catch: 1 inbound `claim_catch`,** then `catch_confirmed` and `lobby_update` to the room, plus 1 push to the caught hider.
- **Reconnect: 1 new connection, 1 `resume`,** and a grace timer (`DISCONNECT_GRACE_S`, default 30 s) armed on disconnect.
- **Game end: 1 timer** (`GAME_DURATION_S`, default 1,800 s). `game_over` and `lobby_update` go to the room, and a push goes to everyone subscribed.

On Cloudflare, outbound messages cost no requests, so **per-role fan-out adds no request cost.** The billable inputs are inbound messages, connections, alarms, storage rows, and the time the DO stays awake.

## Worked estimate

Assumptions: one Durable Object per game. Every inbound message is a DO request (÷20 under the published ratio). Every connection is 1 Workers request plus 1 DO request. Timers are alarms: worst case, one alarm invocation per ping, per grace period and for the game end. A game keeps its DO awake from lobby to end screen (15 min extra): with 12 phones sending every 5–10 s, the object is never idle long enough to hibernate. ~150 extra inbound messages per game for lobby, push subscribe, catches and resume. ~100 HTTP API calls per game (auth, session, VAPID key). **20 reconnects per player per game**, a pessimistic figure for phones in the field.

### Worst-case day: 4 games on the same day, 12 players, 120 min, 5 s cadence

| Quantity | Per game | Per day (×4) |
|---|---|---|
| `position_update` messages (12 × 7,200 s ÷ 5 s) | 17,280 | 69,120 |
| Other inbound messages | ~150 | ~600 |
| WebSocket connections (12 + 240 reconnects) | 252 | 1,008 |
| Alarm invocations (40 pings + 240 graces + 1 end) | 281 | 1,124 |
| HTTP API requests | ~100 | ~400 |
| DO awake time (135 min) | 8,100 s | 32,400 s |

| Limit | Usage/day | % of free | Notes |
|---|---|---|---|
| DO requests (20:1 applied) | 69,720 ÷ 20 + 1,008 + 1,124 = **5,618** | **5.6 %** | published billing rule |
| DO requests (1:1, pessimistic) | 69,720 + 1,008 + 1,124 = **71,852** | **71.9 %** | if the ratio is paid-billing only |
| DO duration | 32,400 s × 0.125 GB = **4,050 GB-s** | **31.2 %** | no hibernation during play |
| Workers requests | 1,008 + 400 = **1,408** | **1.4 %** | static assets free |
| SQLite rows written: naive, 1 row/tick | 69,120 | 69 % | upsert on an integer or rowid key only |
| SQLite rows written: naive, upsert with composite-key index (2/tick) | 138,240 | **138 % (fails)** | |
| SQLite rows written: naive, upsert + indexed history (4/tick) | 276,480 | **276 % (fails)** | |
| SQLite rows written: in-memory positions (events, alarms, one snapshot row/min) | ~2,000 | ~2 % | recommended |
| SQLite rows read: naive, read the snapshot each tick (12 rows) | 829,440 | 16.6 % | |
| SQLite rows read: in-memory positions | ≈0 | ≈0 % | |
| D1 (accounts, sessions) | ~1,500 reads, <100 writes | <0.1 % | |
| Storage | a few MB even with full position history | <0.1 % of 5 GB | |

### Typical week: 3 games, at most one per day, 9 players, 90 min, 8 s cadence (`POSITION_CADENCE_S` default)

With 6,075 ticks per game, a game day uses **787 GB-s (6.1 %)** of duration, and **~6,500 DO requests (6.5 %)** even at 1:1. With in-memory positions, every other limit stays under 2 %. **Headroom: about 15×.**

### Break-even points (in-memory positions)

- **DO duration:** 13,000 GB-s ÷ (0.125 GB × 3,600 s) = **28.9 awake DO-hours per day**, regardless of player count.
- **DO requests at 1:1:** 12 players × 720 ticks/h = 8,640 req/h, so **~11.6 game-hours per day**. At 20:1 that becomes ~230 h, far past the duration limit.
- **Rows written if every tick is saved with indexes (4 rows):** 100,000 ÷ 34,560 rows/h = **~2.9 game-hours per day**. That is the only design under which a single long session can hit a limit.

## Design constraints this implies

1. **Don't write each tick to storage.** Keep latest positions in DO memory. Persist catches, lifecycle events and an occasional checkpoint. If position history (replay) is wanted, batch it, for example one JSON row per player per minute.
2. **Use the WebSocket Hibernation API with protocol-level pings** (`setWebSocketAutoResponse`), not app-level heartbeats. Socket.IO/Engine.IO heartbeats are application messages: in lobbies and idle tabs they would count as requests and keep the DO awake. During play the DO stays awake anyway, so hibernation only saves on lobby, end-screen and idle time.
3. **Timers:** each alarm invocation is a request and each `setAlarm()` a row written. While the DO is awake mid-game, `setTimeout` costs neither. Alarms are needed only for timers that must survive eviction (game end), so pessimistically counting every timer as an alarm overstates the cost.
4. **Reset at 00:00 UTC, and a DO over the limit fails with errors.** For a European evening game that is 01:00–02:00 local time. It can only bite on an extreme day, but consider a usage warning.
5. **CPU:** the 10 ms Workers limit applies to the edge Worker, so it should only route and authenticate. Game logic runs inside DO invocations (30 s each). scrypt N=2^15 password hashing (already flagged on the map) won't fit in a 10 ms Worker.

## Open points (unverified)

- **Does the 20:1 ratio apply to the free 100,000/day quota?** The pricing page says "for compute requests billing-only" and doesn't say either way for Free. The estimate fits under both readings. Check empirically with the dashboard's DO request metrics during a test game.
- **Does the Workers 50-subrequest limit apply inside a DO invocation** (a reveal fanning out Web Push `fetch`es)? At ≤11 hunters it's irrelevant, but it matters for larger games.

## Sources

- [W-limits] Cloudflare Workers, Limits (updated 2026-09-05): <https://developers.cloudflare.com/workers/platform/limits/>
- [W-pricing] Cloudflare Workers, Pricing (updated 2026-08-28): <https://developers.cloudflare.com/workers/platform/pricing/>
- [SA-billing] Workers Static Assets, Billing and limitations (updated 2026-04-23): <https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>
- [DO-pricing] Durable Objects, Pricing (updated 2026-08-25): <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- [DO-limits] Durable Objects, Limits (updated 2026-06-01): <https://developers.cloudflare.com/durable-objects/platform/limits/>
- [DO-websockets] Durable Objects, Use WebSockets (hibernation) (updated 2026-06-19): <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- [DO-sql] Durable Objects, SQLite Storage API (updated 2026-05-27): <https://developers.cloudflare.com/durable-objects/api/sql-storage/>
- [DO-faq] Durable Objects, FAQ: <https://developers.cloudflare.com/durable-objects/reference/faq/>
- [D1-pricing] D1, Pricing (updated 2026-04-21): <https://developers.cloudflare.com/d1/platform/pricing/>
- Changelog, Durable Objects on Workers Free plan (2025-04-07): <https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/>

[W-limits]: https://developers.cloudflare.com/workers/platform/limits/
[W-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[SA-billing]: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
[DO-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[DO-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[DO-websockets]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[DO-sql]: https://developers.cloudflare.com/durable-objects/api/sql-storage/
[DO-faq]: https://developers.cloudflare.com/durable-objects/reference/faq/
[D1-pricing]: https://developers.cloudflare.com/d1/platform/pricing/
