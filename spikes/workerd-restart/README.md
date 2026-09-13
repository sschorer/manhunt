# Spike: workerd in Docker across restarts

Throwaway spike for the wayfinder ticket "Spike: does a workerd Docker container keep DO data, alarms and WebSockets across restarts?". It is not meant to be merged.

## What it is

- `worker.js`: one SQLite-backed Durable Object (`Game`). It has a key/value table and an event log, sets alarms, accepts hibernating WebSockets with a `"ping"`/`"pong"` auto-response, and stores a seat attachment on each socket.
- `config.capnp`: the hand-written workerd config: one worker, one DO namespace with `enableSql`, `localDisk` storage on a `/data` volume, and plain HTTP on port 8080.
- `Dockerfile`: the `workerd` binary from npm (`workerd@1.20260911.1`), copied into `debian:bookworm-slim`.
- `test.mjs` and `test2.mjs`: scripts that run the scenarios below with the Docker CLI and Node 24's built-in `WebSocket`.

Run with `node test.mjs` and `node test2.mjs` from this directory. Docker is required.

## Results (workerd 1.20260911.1, Docker 29.7.2, x86_64)

| Scenario | Result |
|----------|--------|
| DO SQLite data after `docker stop` + `start` | Kept |
| DO SQLite data after `docker kill` (SIGKILL) right after a write | Kept |
| Alarm that falls due while the container is stopped (graceful stop) | Fires on startup, 12 ms after the container came up, `retryCount=0` |
| Alarm that falls due while the container is stopped (after SIGKILL) | Fires on startup, `retryCount=0` |
| Alarm while running, object hibernated, socket open | Fires; the socket receives the message |
| Idle socket past the 10 s eviction | Socket stays open; the object is evicted and re-constructed on the next message; `serializeAttachment` data (the seat) is intact |
| `"ping"` while hibernated | `"pong"` returned without constructing the object |
| Client view of a restart | Socket closes with `1006` (abnormal); no close frame is sent |
| Reconnect after restart | Works immediately |
| `docker stop` with **no** open WebSockets | Exits in ~160 ms (exit code 0), with or without `--init` |
| `docker stop` with an **open** WebSocket | workerd does not exit on SIGTERM; Docker SIGKILLs after the stop timeout (10 s, exit code 137) |
| Cold start to first response | ~35 ms fresh volume, ~105 ms with existing data |
| Image size | ~68 MB |
| Hand-written `config.capnp` | 25 lines for one worker, one DO namespace, disk storage and one socket |

On-disk layout under the `localDisk` directory is one subdirectory per `uniqueKey`, containing `<object id>.sqlite` (plus `-wal`/`-shm`) and a `metadata.sqlite` that holds the alarm schedule.

## What it means

- **Persistence holds up.** For a single-instance Docker target, workerd keeps DO data and alarms across both graceful and hard restarts. Hibernation behaves like Cloudflare, and the auto-response doesn't wake the object.
- **Every restart drops sockets.** Clients see `1006` and must reconnect, which the planned `partysocket` reconnect plus snapshot-on-reconnect already covers.
- **Redeploys during live games hang for the full timeout.** workerd waits on open WebSockets instead of exiting on SIGTERM, so each redeploy waits out the whole stop timeout before the kill. Data survives the kill, so a short `stop_grace_period` (e.g. 2–3 s) in compose is safe and cuts the redeploy gap.
- **Keep the storage key stable.** `uniqueKey` must never change, since it names the storage directory.
- **Pin the workerd version.** `localDisk` is still marked experimental, and its on-disk layout could change.
