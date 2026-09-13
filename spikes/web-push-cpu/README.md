# Spike: Web Push CPU time on a free-plan Cloudflare account

Throwaway spike for the wayfinder ticket "Spike: measure Web Push CPU in a Durable Object on a free-plan account". It is not meant to be merged.

It measures how much CPU one Web Push send costs with `@block65/webcrypto-web-push` 2.0.0 (RFC 8291 encryption plus a VAPID JWT) in three places:

- inside a Worker request (`/worker/send`);
- after the response, using `ctx.waitUntil` (`/worker/waituntil`);
- inside a SQLite-backed Durable Object (`/do/send`).

`/…/build` encrypts without sending, and `/…/noop` is the baseline. Every push goes to a deliberately invalid FCM endpoint (FCM answers `410`), so no real device is notified. Throwaway VAPID and subscription keys come from `gen-keys.mjs` and are gitignored.

## Local baseline (already measured)

`node bench-node.mjs` on an AMD Ryzen 9 5900X:

- first push (cold, including crypto warm-up): **9.07 ms CPU**;
- warm average over 200 pushes: **1.05 ms CPU per push**.

`wrangler dev` runs every endpoint successfully (`HTTP 200`; FCM `410` for each send).

## Cloudflare free-plan results (measured 2026-09-13)

Deployed with Wrangler 4.131.1. Each path was called 6 times, and CPU time was read from `wrangler tail`. The `stateless` rows under `/do/*` are only the Worker forwarding the request (0–1 ms) and are left out of the table.

| Path | Where it runs | 1 push (median) | 10 pushes (median) | Max |
|------|---------------|-----------------|--------------------|-----|
| `/do/send` | Durable Object | 2 ms | 16 ms | 17 ms |
| `/do/build` (encrypt only) | Durable Object | 2 ms | 9 ms | 9 ms |
| `/worker/send` | Worker | 2 ms | 21 ms | 22 ms |
| `/worker/build` (encrypt only) | Worker | 2 ms | 12 ms | 13 ms |
| `/worker/waituntil` | Worker, after response | 2 ms | 23 ms | 48 ms |
| `noop` | both | 0 ms | — | 1 ms |

Every request reported outcome `ok`.

- **Cost per push:** about **1.6 ms CPU** per push sent from the Durable Object, ~0.9 ms of it encryption and JWT signing.
- **Worker CPU limit:** ten pushes from a Worker take 21–23 ms (48 ms worst case), more than twice the free plan's 10 ms Worker CPU limit. Cloudflare didn't reject these requests, but relying on that isn't safe.
- **`waitUntil`:** it doesn't escape the limit, because its CPU time counts for the same invocation.
- **Durable Object headroom:** a reveal push to 11 Hunters costs about 18 ms, far inside a Durable Object's 30 s.

## Run it on your free-plan account

Deploy from your own machine only, never from GitHub.

```sh
cd spikes/web-push-cpu
npm install
node gen-keys.mjs
npx wrangler login            # browser login to the free-plan account
npx wrangler deploy           # prints the https://manhunt-spike-web-push-cpu.<subdomain>.workers.dev URL
node measure.mjs <that URL>   # tails CPU time while calling each endpoint 6 times
npx wrangler delete           # remove the spike Worker afterwards
```

`measure.mjs` prints each path's first, median and max `cpuTime`, split by execution model (Worker vs Durable Object), taken from `wrangler tail` events. The same numbers are visible in the dashboard under the Worker's Observability tab.
