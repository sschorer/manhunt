# Research: can workerd run Manhunt in production on Docker?

Ticket: [#54](https://github.com/sschorer/manhunt/issues/54) (map [#53](https://github.com/sschorer/manhunt/issues/53)). Researched 2026-09-13 against workerd `main` / release `v1.20260913.1`.

## Verdict

**Yes, for Manhunt's load, with caveats.** A single workerd process in a Docker container can run the same Worker + Durable Object code as Cloudflare, with SQLite-backed DO storage on a mounted volume, persistent alarms, and WebSocket hibernation. The caveats:

- Durable Objects work correctly only on **one workerd instance (one thread)**. Cloudflare's own attempt to lift that limit was closed without merging on 2026-09-11.
- `localDisk` DO storage is explicitly marked **EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE** in the config schema.
- Several hosted-platform conveniences are **not** part of plain workerd: D1, static assets, cron triggers, TLS certificate management, and a Wrangler-to-workerd config export. Each has to be supplied by us, either as a small shim or as infra around the container.

For "a handful of private friends' games a week", the single-instance limit does not matter. The real cost is that the Docker target needs its own hand-written `config.capnp` plus a few shims. It is not a zero-work "same runtime, same config" target.

## Findings

### Production intent and support status

- The README lists "As an application server, to self-host applications designed for Cloudflare Workers" as a primary use, and has a "Serving in production" section (systemd, `--socket-fd`). Source: [workerd README](https://github.com/cloudflare/workerd/blob/main/README.md).
- The README warns: "`workerd` is not a hardened sandbox". That matters only for untrusted code, and we run our own code. Source: same.
- Versioning: "Updating `workerd` to a newer version will never break your JavaScript code". The version is the maximum supported compatibility date. Releases ship roughly daily (`v1.20260909.1` … `v1.20260913.1`). Sources: README; [releases](https://github.com/cloudflare/workerd/releases).
- Durable Objects are the stated gap. Kenton Varda wrote in PR #6780 (2026-05-23): "workerd has always supported running Durable Objects for the purpose of local testing, but only within the scope of a single instance running on a single thread." The design doc says: "workerd is viable to use to host Workers apps in production – *except* apps that use Durable Objects. Durable Objects only work properly in workerd if you send all traffic to a single instance of workerd, which can only use a single thread." Sources: [PR #6780](https://github.com/cloudflare/workerd/pull/6780); [design doc gist](https://gist.github.com/kentonv/baeebc2de19c6ae81d71e09e822b6c45).
- PR #6780 ("cluster mode") was **closed unmerged on 2026-09-11**. NFS turned out too slow for the lock protocol. The author notes it works for single-machine multi-process but is "really overengineered for that case. We should be able to create a much simpler multi-threaded design". There is no multi-instance DO support today, and none is merged or scheduled. Source: [PR #6780 closing comment](https://github.com/cloudflare/workerd/pull/6780).
- The schema still says: "TODO(someday): Support distributing objects across a cluster. At present, objects are always local to one instance of the runtime." Source: [workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp).

### Durable Objects with storage that survives restarts

- `durableObjectStorage` has three modes: `none`, `inMemory` ("intended for local testing purposes", lost on exit), and `localDisk`. Source: [workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp).
- `localDisk` is marked "\*\* EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE \*\*". It points at a writable `DiskDirectory` service. Each class gets a subdirectory named by `uniqueKey`, with one `<id>.sqlite` file per object (plus `-wal`/`-shm`). Unlike analytics-engine or memory-cache bindings, it is **not** gated behind the `--experimental` CLI flag. Sources: workerd.capnp; the `--experimental` checks in [server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c++).
- `enableSql`: "workerd uses SQLite to back all Durable Objects, but the SQL API is hidden by default … This flag should be enabled when testing code that will run on a SQLite-backed namespace." This is the same `ctx.storage.sql` API as SQLite-backed DOs on Cloudflare. Source: workerd.capnp.
- Losing `uniqueKey` or `durableObjectUniqueKeyModifier` loses the data: "DO NOT LOSE this key, otherwise it may be difficult or impossible to recover stored data." The key must be stable config, and the volume must be backed up. Source: workerd.capnp.
- Eviction: "By default, Durable Objects are evicted after 10 seconds of inactivity". `preventEviction` exists but is "only supported in Workerd; production Durable Objects cannot toggle eviction". Avoid it to keep parity. Source: workerd.capnp.

### Alarms

- With `localDisk`, each namespace gets an `AlarmScheduler` "backed by on-disk storage in the namespace directory, alongside the per-actor .sqlite files" (`metadata.sqlite`). Without disk storage it falls back to an in-memory scheduler. Source: [server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c++).
- On startup the scheduler loads alarms from its `_cf_ALARM` table (`loadAlarmsFromDb()`), and it retries with backoff, jitter, and a maximum try count. So alarms survive restarts on a persistent volume. Code comment: "right now … we retain the entire set of queued alarms in memory", which is fine at our scale. Source: [alarm-scheduler.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/alarm-scheduler.c++).

### WebSocket hibernation

- workerd includes the hibernation manager (`src/workerd/io/hibernation-manager.c++`). In `server.c++`, after 10 s of inactivity the actor is destroyed and `hibernateWebSockets()` is called, so the connections stay open while the object is gone from memory. This is the same `ctx.acceptWebSocket()` model that [Cloudflare's docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) describe. Source: [server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c++).
- Hibernation state is in-process. A workerd restart or container redeploy drops every WebSocket, so clients must reconnect. Manhunt already has resume-with-session-token (#24). Cloudflare also restarts DOs on deploys, so this is parity rather than a new gap.
- Hosted-platform limitation that applies to both targets: only server-side (accepted) WebSockets hibernate, not outgoing ones. Source: [workerd#4864](https://github.com/cloudflare/workerd/issues/4864).

### D1 equivalent / local SQLite fallback

- workerd has **no native D1 backend**. The D1 client API is a `wrapped` binding (`cloudflare-internal:d1-api`) that sends HTTP (`/query`, `/execute`, `/dump`) to an inner fetcher service. Something has to implement that service. Sources: [workerd.capnp `WrappedBinding`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp); [d1-api.ts](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/d1-api.ts).
- Miniflare (`wrangler dev`) supplies that service as its own internal `D1DatabaseObject` Durable Object with `localDisk` storage, wired through the wrapped binding. That script is Miniflare-internal and not a published workerd component. Source: [miniflare d1 plugin](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/d1/index.ts).
- Options for Docker:
  1. **Use DO SQLite for everything**, for example a singleton "accounts" DO next to per-game DOs. This is identical on both targets and needs no D1.
  2. Vendor or re-implement a D1-protocol DO shim and bind it via `wrapped`. That is fragile, because the protocol is internal.
  3. Put D1 behind our own repository interface, which is an adapter.

### Config and packaging into an image

- Config is Cap'n Proto text (`config.capnp`). Wrangler does not generate it: no first-party export was found in the workerd or workers-sdk repos. The Docker target therefore keeps a second, hand-maintained deployment descriptor next to `wrangler.jsonc`, covering bindings, DO namespaces, storage, sockets, and the network. Source: [README "Configuring workerd"](https://github.com/cloudflare/workerd/blob/main/README.md).
- Our code would be bundled with esbuild or `wrangler deploy --dry-run` and then `embed`ded into the config.
- Binaries ship via npm (`npx workerd`). Linux needs glibc 2.35+ (Ubuntu 22.04 / Debian Bookworm), and the CPU needs SSE4.2+CLMUL on x86-64 or CRC on arm64. That rules out Alpine/musl base images. There is **no official Docker image**. The old request ([workerd#46](https://github.com/cloudflare/workerd/issues/46)) was closed in 2023 after glibc/libunwind issues, which were resolved by the Bookworm baseline. Source: README "Running workerd".
- `workerd compile` "Builds a self-contained binary from a config", embedding config and code. That fits a slim `debian:bookworm-slim` or distroless-glibc image. Source: [workerd.c++ CLI](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.c++).
- Secrets and env: the `fromEnvironment` binding reads a process environment variable, which maps cleanly onto Docker `-e` / compose secrets. Source: workerd.capnp.
- Static assets: plain workerd has only `DiskDirectory`, which is "very bare-bones, generally not suitable for serving a web site on its own … no attempt is made to guess the `Content-Type` header". Workers Static Assets is a Miniflare-level router/asset worker, not a workerd feature. The frontend needs a small asset-serving Worker, or a reverse proxy serving `client/dist`. Sources: workerd.capnp; [miniflare assets workers](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare/src/workers/assets).
- Cron triggers: the schema has no cron or trigger config. workerd can *handle* `scheduled` events but does not schedule them. Use DO alarms instead, which works on both targets. Source: workerd.capnp.

### TLS / reverse proxy

- Sockets support `https = (options, tlsOptions)` with a single PEM `keypair`. There is no SNI keypair selection ("TODO(someday): Support SNI-based keypair selection?") and no ACME/Let's Encrypt. Source: [workerd.capnp `TlsOptions`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp).
- In practice, serve plain HTTP from workerd inside the container and terminate TLS in a reverse proxy (Caddy, Traefik, nginx), as ADR-003 already assumes. Outbound `fetch` goes through the configurable `internet` network service with CIDR allow/deny lists, which is useful for the SSRF guard in `server/push/ssrf.ts`.

## Gaps and risks for "one runtime everywhere vs shared core + adapters"

| Concern | Same on both? | Note |
|---|---|---|
| Worker + DO code, `ctx.storage.sql`, alarms, WS hibernation | Yes | Same runtime code; strongest argument for one runtime. |
| DO storage stability | Mostly | `localDisk` on-disk layout is "experimental, subject to backwards-incompatible change". Pin the workerd version and back up the volume. |
| Scale-out | No | Single instance only on Docker; cluster mode abandoned 2026-09-11. Acceptable for our load; blocks HA (already out of scope). |
| D1 | No | No native D1 in workerd. Avoid D1, or accept a shim or adapter. |
| Deployment config | No | `wrangler.jsonc` vs hand-written `config.capnp`, which can drift. Needs a CI smoke test for the Docker target. |
| Static assets, TLS, cron | No | Infra around the container (asset Worker or proxy, reverse proxy, alarms instead of cron). |
| Security hardening | n/a | Not a hardened sandbox; fine for first-party code. |

Implication: **one runtime (workerd) everywhere is viable** if the design uses only DO SQLite (no D1), alarms (no cron), and plain WebSockets with hibernation. What remains is a thin deployment layer (`config.capnp`, reverse proxy, asset serving), not application adapters.

## Open questions surfaced

- Does Miniflare/`wrangler dev` DO SQLite storage use the same on-disk layout as plain workerd `localDisk`? That decides whether local dev data and Docker volumes are interchangeable.
- Should Docker run plain `workerd` with a hand-written capnp, or run Miniflare in Node, which gives D1 and assets for free but is described as "a simulator for developing and testing" ([miniflare README](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md))?
- Backup/restore strategy for the DO SQLite volume (copying live `.sqlite` + WAL files safely).
- Spike needed: build a minimal DO + hibernating WebSocket + alarm Worker, run it with `workerd serve` in `debian:bookworm-slim`, restart the container, and verify that storage and alarms persist.
