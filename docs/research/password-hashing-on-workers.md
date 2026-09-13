# Password hashing under Cloudflare Workers' CPU limits

Research for [#57](https://github.com/sschorer/manhunt/issues/57), part of map [#53](https://github.com/sschorer/manhunt/issues/53). Researched 2026-09-13.

**Question:** `server/auth/password.ts` hashes with scrypt (N=2^15, r=8, p=1). Which password hashing options work under the Workers **free plan** CPU limits (scrypt, PBKDF2 via WebCrypto, Argon2/bcrypt via WASM)? How do they compare with current OWASP guidance, and does the same choice run on the self-hosted Docker target?

## Verdict

- **In a plain free-plan Worker, no option is both safe by OWASP's standards and under the limit.** The limit is 10 ms of CPU per request. Today's scrypt takes about 54 ms of CPU. PBKDF2 is capped by Cloudflare at 100,000 iterations, which is one sixth of OWASP's 600,000.
- **In a SQLite-backed Durable Object the 10 ms limit doesn't apply.** SQLite-backed DOs are available on the free plan with a 30 s CPU budget per request. Inside a DO, scrypt via `nodejs_compat` `node:crypto` is viable.
- **Recommendation: keep scrypt, run hashing and verification inside a Durable Object, and raise the cost to OWASP's `N=2^15, r=8, p=3`.** That setting uses 32 MiB, fits the 128 MB isolate, and is under workerd's scrypt cost cap. The same `node:crypto` code runs unchanged on Node, so the Docker target needs no adapter. The self-describing `scrypt$N$r$p$...` format already carries the new parameters.
- Not recommended: PBKDF2 (capped, and weakest on OWASP's list), and Argon2id/bcrypt via WASM (the npm packages break on Workers, the libraries are stale, and they add a dependency without beating scrypt-in-a-DO).
- **Still needs confirming on a real deployment.** Two things here come from open-source workerd, not from Cloudflare's production service: the scrypt cost cap and memory headroom. Production can override limit hooks, and it does for PBKDF2. See "Open questions".

## Facts from primary sources

### Workers and Durable Objects CPU limits

| Fact | Source |
| --- | --- |
| Workers Free plan CPU time: **10 ms** per HTTP request. Paid: 30 s by default, up to 5 min. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| "CPU time measures how long the CPU spends executing your Worker code. Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time." Crypto isn't listed as an exception, so time spent in native crypto (BoringSSL) on the isolate thread counts. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| "Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit." Going over returns Error 1102 "Worker exceeded resource limits". | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Memory: 128 MB per isolate, including WASM allocations. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Free plan includes Durable Objects, **SQLite-backed only**: 100,000 requests/day and 13,000 GB-s/day. | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| SQLite-backed DOs: 30 s of active CPU per request by default, configurable up to 5 min, on Free and Paid. "Each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds." | [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |

### What crypto Workers provide

| Fact | Source |
| --- | --- |
| WebCrypto `deriveBits`/`deriveKey` supports ECDH, HKDF and PBKDF2. It has no Argon2 or scrypt. Non-standard `crypto.subtle.timingSafeEqual` is available. | [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) |
| **PBKDF2 is capped at 100,000 iterations**: "Pbkdf2 failed: iteration counts above 100000 are not supported". The code comment says this is deliberate, to stop a high count from triggering the dead man's switch, and admits the cap is "*WAY* below the recommended minimum iterations". | workerd [`limit-enforcer.h` L29, L82-95](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/io/limit-enforcer.h#L29), [`pbkdf2.c++` L60-66](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/api/crypto/pbkdf2.c++#L60-L66), [`impl.c++` checkPbkdfLimits](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/api/crypto/impl.c++) |
| The issue asking to lift the cap, [cloudflare/workerd#1346](https://github.com/cloudflare/workerd/issues/1346), is still **open**. Its latest comments are from 2026-08 and there's no maintainer fix. | GitHub |
| `node:crypto` under `nodejs_compat` supports `scrypt`/`scryptSync`, `pbkdf2`, `timingSafeEqual` and `randomBytes`. "argon2 and argon2Sync are not supported." | [Workers node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/) |
| workerd's `scrypt` rejects `N*r*p > 2^20` ("Scrypt failed: cost exceeds maximum"). That's the default limit hook, and self-hosted workerd doesn't override it. | [`limit-enforcer.h` L30, L97-105](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/io/limit-enforcer.h#L30), [`api/node/crypto.c++` L90-105](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/api/node/crypto.c++#L90-L105) |
| workerd's async `scrypt()` computes the result **synchronously on the isolate thread** inside a Promise executor, since there's no thread pool. All of it counts as CPU time for the request. | [`crypto_scrypt.ts` L176-178](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/node/internal/crypto_scrypt.ts#L176-L178) |
| Self-hosted `workerd` removes the PBKDF2 cap ("No limit on the number of iterations in workerd"). | [`server/server.c++` L3326-3329](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/server/server.c++#L3326-L3329) |

### WASM on Workers

| Fact | Source |
| --- | --- |
| V8's WASM code-generation callback allows compiling only when `eval` is allowed. `eval` is allowed only during startup (global scope), and only with the `allow_eval_during_startup` flag, which is the default from 2025-06-01. At request time, `WebAssembly.compile(bytes)` fails with "Wasm code generation disallowed by embedder". | [`jsg/setup.c++` L615-620](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/jsg/setup.c++#L615-L620), [`io/worker.c++` L2012-2013](https://github.com/cloudflare/workerd/blob/db75e6012cdca18f08e0a7d1ce5f10ad3b0866ad/src/workerd/io/worker.c++#L2012-L2013), [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) |
| The supported approach is to import a `.wasm` file, which Wrangler bundles as a precompiled `WebAssembly.Module`. | [Workers Wasm in JavaScript](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/) |

### OWASP Password Storage Cheat Sheet (current)

Source: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

- **Order of preference:** Argon2id first, then scrypt if Argon2id isn't available, then bcrypt for legacy systems, then PBKDF2 only when FIPS-140 compliance is required.
- **Argon2id** (equivalent options): m=47104 (46 MiB) t=1 p=1; m=19456 (19 MiB) t=2 p=1; m=12288 t=3 p=1; m=9216 t=4 p=1; m=7168 t=5 p=1.
- **scrypt** (equivalent options): N=2^17 r=8 p=1 (128 MiB); N=2^16 r=8 p=2; **N=2^15 r=8 p=3 (32 MiB)**; N=2^14 r=8 p=5; N=2^13 r=8 p=10.
  - Manhunt's current `N=2^15, r=8, p=1` is **below** this minimum. It needs p=3.
- **bcrypt:** work factor 10 or more. Input is capped at 72 bytes. Pre-hashing requires HMAC with a pepper, to avoid password shucking.
- **PBKDF2:** HMAC-SHA256 at 600,000 iterations, HMAC-SHA512 at 220,000, HMAC-SHA1 at 1,400,000 (legacy only).

### Node (Docker target)

- `crypto.argon2()` / `argon2Sync()` were added in Node **v24.7.0**. Node's `scrypt` `maxmem` defaults to 32 MiB, and it's an error when about `128*N*r > maxmem`. Source: [Node crypto docs](https://github.com/nodejs/node/blob/main/doc/api/crypto.md).
- Node's async `scrypt` runs on the libuv thread pool, so it doesn't block the event loop. workerd's doesn't (see above).

## Measured CPU cost (indicative)

These numbers come from Node v24.15.0's native `node:crypto` on an AMD Ryzen 9 5900X, as CPU ms per operation. Cloudflare's hardware and BoringSSL build will differ, so treat these as order-of-magnitude figures, not Workers measurements.

| Operation | CPU ms/op | vs 10 ms free Worker limit |
| --- | --- | --- |
| scrypt N=2^14 r=8 p=1 | 25 | over |
| scrypt N=2^15 r=8 p=1 (today) | 54 | over (about 5x) |
| scrypt N=2^15 r=8 p=3 (OWASP) | about 160 (3 x p=1) | over; fine inside a DO's 30 s |
| scrypt N=2^17 r=8 p=1 (OWASP) | 222 | over; 128 MiB won't fit the 128 MB isolate |
| PBKDF2-SHA256 100k (Workers cap) | 12 | borderline over |
| PBKDF2-SHA256 600k (OWASP) | 72 | over, and not allowed on Workers anyway |
| PBKDF2-SHA512 210k | 77 | over, and not allowed on Workers anyway |
| Argon2id m=19456 t=2 p=1 (native) | 36 | over; native isn't available on Workers, and WASM is slower |

## Options

### A. scrypt via `node:crypto`, run inside a Durable Object (recommended)

- **Workers free:** viable inside a SQLite-backed DO (30 s CPU per request). Not viable in the stateless Worker (10 ms).
- **Parameters:** `N=2^15, r=8, p=3`.
  - Memory: 32 MiB (128·N·r). Leaves room in the 128 MB isolate.
  - Cost: N·r·p = 786,432, under workerd's 2^20 cap.
  - CPU: about 160 ms per login.
  - OWASP's N=2^16 r=8 p=2 (64 MiB, cost 1,048,576, exactly at the cap) also passes the check, but has less memory headroom.
  - OWASP's N=2^17 r=8 p=1 needs about 128 MiB and won't fit.
- **Security:** meets OWASP's scrypt minimum, which is OWASP's second choice, used when Argon2id isn't available. Here it isn't, natively.
- **Docker/Node:** identical code, no dependency. It keeps the "no third-party dependency for a security-critical primitive" rule in `password.ts`.
- **Docker/workerd:** same caps as Cloudflare, so the same parameters work.
- **Cost on the free plan:** each sign-in or sign-up is one DO request, out of 100,000/day, plus about 0.2 s of duration. That's negligible against 13,000 GB-s/day at a handful of games a week.
- **Change needed:** `P = 3`, plus routing hash and verify through a DO. The current `maxmemFor` gives 256·N·r·p = 192 MiB for p=3. That's only the upper bound Node checks, and actual use is 128·N·r = 32 MiB, but if workerd's `maxmem` enforcement differs, lower it. Verify in the spike.

### B. PBKDF2 via WebCrypto

- **Workers free:** capped at 100,000 iterations (about 12 ms native locally), so it only just fits, or doesn't, in 10 ms. It fits easily inside a DO.
- **Security:** a sixth of OWASP's SHA-256 minimum, and PBKDF2 is last on OWASP's list, recommended only for FIPS.
  - Chaining several 100k calls to "reach" 600k is a home-made construction, not standard PBKDF2. Avoid it.
  - The cap issue (workerd#1346) has been open for about 3 years.
- **Docker/Node:** available via WebCrypto or `node:crypto`. Self-hosted workerd lifts the cap, but Cloudflare's service doesn't, so parity would force the weaker count on both.
- **Not recommended.**

### C. Argon2id or bcrypt via WASM

- **Workers:**
  - [hash-wasm](https://github.com/Daninet/hash-wasm) (argon2id, bcrypt, scrypt) inlines WASM as base64 and compiles it at runtime. Its maintainer confirms that fails on Workers ("Wasm code generation disallowed by embedder"): you must extract and re-bundle the `.wasm` ([discussion #56](https://github.com/Daninet/hash-wasm/discussions/56)). Its last release was v4.12.0 on 2024-11-19.
  - [openpgpjs/argon2id](https://github.com/openpgpjs/argon2id) supports a custom WASM loader (`setupWasm`), which lets you pass imported `.wasm` modules. Its last push was 2023-08.
  - In the 10 ms Worker, Argon2id at OWASP parameters costs more than native (about 36 ms) and doesn't fit. Inside a DO it would fit.
- **Security:** Argon2id is OWASP's first choice. bcrypt is legacy, with a 72-byte input limit.
- **Docker/Node:** Node has native `crypto.argon2` since v24.7, but Workers doesn't. For one code path on both targets you'd ship the WASM build everywhere, or keep an adapter (native on Node, WASM on Workers). That goes against the map's "single runtime over adapters" preference and adds a third-party dependency with slow maintenance.
- **Not recommended now.** The gain over OWASP-compliant scrypt is small for a private friends' app. Revisit if Workers adds native Argon2.

### D. Pure-JS implementations (e.g. `@noble/hashes`)

- [noble-hashes](https://github.com/paulmillr/noble-hashes) is well maintained (2.4.0, 2026-08-27) and runs anywhere with no WASM. But pure JS is slower than native `node:crypto` scrypt, which Workers already provide, so it adds nothing here.

## Open questions

1. **Deployed spike:** on a real free-plan account, does `scrypt(N=2^15, r=8, p=3)` via `nodejs_compat`, inside a SQLite-backed DO, finish without Error 1102 or a memory error? This confirms three things open-source workerd can't: the production scrypt cost cap, `maxmem` behaviour, and real CPU ms.
2. **Auth placement:** which Durable Object owns sign-in (a dedicated auth/accounts DO, or an existing one), and how does the stateless Worker forward login requests to it? This affects the runtime/architecture decision.
3. **Login throttling:** each attempt costs about 160 ms of DO CPU and one of 100,000 free DO requests a day. Should failed logins be rate-limited per account or IP, to prevent brute force and quota exhaustion, and where does that counter live?
