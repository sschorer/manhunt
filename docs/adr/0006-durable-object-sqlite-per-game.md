---
status: accepted (supersedes ADR-004 in docs/arc42.md)
---

# One Durable Object with SQLite per game replaces Redis and PostgreSQL

With one Workers runtime on both targets, D1 isn't available under plain `workerd`, and Redis and PostgreSQL don't exist on Cloudflare. We store all durable data inside one `GameRoom` Durable Object per game, addressed by `idFromName(joinCode)`: a single SQLite row holding a versioned JSON snapshot, written only when durable state changes. Live positions stay in memory, mirrored onto each player's WebSocket attachment. Writing every position update would exceed the free plan's 100,000 SQLite row writes per day.

## Consequences

- **No data outside a game:** no accounts, history or statistics. A game is deleted when its last seat is released, 24 hours after it ends, or 24 hours after creation. Replay from position history would need a new storage decision.
- **Snapshot upgrades:** schema changes are handled in plain TypeScript when an old snapshot loads. A release must keep loading the previous snapshot version for at least 24 hours, and rolling back is only safe within the same snapshot version.
- **Join codes:** a code can only be reused once its game's storage has been deleted.
