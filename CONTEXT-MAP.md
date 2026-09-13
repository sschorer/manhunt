# Context Map

Manhunt is split into two contexts. Each keeps its own glossary and context-scoped ADRs; system-wide decisions live in `docs/adr/` and the overall architecture in `docs/arc42.md`.

| Context | Glossary | ADRs | Scope |
|---------|----------|------|-------|
| Client | `client/CONTEXT.md` | `client/docs/adr/` | PWA frontend: map rendering, geolocation, offline and reconnect behaviour |
| Server | `server/CONTEXT.md` | `server/docs/adr/` | Authoritative game server: lobby, live game state, push notifications |

`shared/` holds the wire protocol (frame types, message payloads, validators) imported by both contexts. It has no glossary of its own; its terms come from the server glossary.
