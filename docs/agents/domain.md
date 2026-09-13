# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: the root `CONTEXT-MAP.md` points at one `CONTEXT.md` per context. The contexts are `client/` (the PWA frontend) and `server/` (the authoritative game server).

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at `client/CONTEXT.md` and `server/CONTEXT.md`. Read each one relevant to the topic.
- **`docs/adr/`** — system-wide decisions. Also check `client/docs/adr/` or `server/docs/adr/` for context-scoped decisions in the area you're about to work in.
- **`docs/arc42.md`** — the architecture reference for the whole system.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```text
/
├── CONTEXT-MAP.md
├── docs/
│   ├── arc42.md
│   └── adr/                           ← system-wide decisions
├── client/
│   ├── CONTEXT.md
│   └── docs/adr/                      ← client-specific decisions
└── server/
    ├── CONTEXT.md
    └── docs/adr/                      ← server-specific decisions
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
