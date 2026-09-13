# Research: can Workers send Web Push?

Ticket: [#56](https://github.com/sschorer/manhunt/issues/56) (map [#53](https://github.com/sschorer/manhunt/issues/53)). Researched 2026-09-13.

## Question

Can a Cloudflare Worker or Durable Object send Web Push with VAPID (RFC 8292, ES256 JWT) and RFC 8291 payload encryption using WebCrypto? Which maintained libraries work there, with or without `nodejs_compat`? And what replaces the SSRF guard in `server/push/ssrf.ts`, which hooks `node:dns` lookups and a `node:https` agent, when a Worker can't resolve DNS or choose the IP it connects to? The answer must also hold for the self-hosted Docker target, which may run on `workerd`.

## Verdict

**Yes.** Every primitive the two RFCs need is in the Workers WebCrypto API, and at least two maintained, dependency-light libraries build RFC 8291 `aes128gcm` requests with it and send them with plain `fetch`. The same code runs unchanged on Node 22+, `workerd`, and Cloudflare.

The current `web-push` library should be **replaced, not shimmed**. The SSRF guard can shrink to a pure URL check plus fetch options, because both runtimes enforce the address check below the app:

- **Cloudflare** does not allow subrequests to IP literals.
- **workerd's default `globalOutbound`** filters *resolved* addresses to public ranges.

## 1. Protocol requirements vs. WebCrypto

| Requirement | Source | WebCrypto primitive | Workers support |
| --- | --- | --- | --- |
| VAPID JWT signed with ECDSA P-256 ("ES256") | [RFC 8292 §2](https://www.rfc-editor.org/rfc/rfc8292.html#section-2) | `ECDSA` sign | Yes ([Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)) |
| `aud` = origin of push resource; `exp` MUST NOT be > 24 h from request; `sub` SHOULD be `mailto:`/`https:` | [RFC 8292 §2, §2.1](https://www.rfc-editor.org/rfc/rfc8292.html#section-2) | none (JSON + base64url) | n/a |
| `Authorization: vapid t=<jwt>, k=<uncompressed P-256 public key, base64url>` | [RFC 8292 §3](https://www.rfc-editor.org/rfc/rfc8292.html#section-3) | `exportKey('raw')` | Yes |
| Ephemeral P-256 ECDH per message | [RFC 8291 §3.1](https://www.rfc-editor.org/rfc/rfc8291.html#section-3.1) | `ECDH` generateKey / deriveBits | Yes |
| HKDF-SHA-256 with `"WebPush: info" \|\| 0x00 \|\| ua_public \|\| as_public` and 16-octet auth secret | [RFC 8291 §3.2–3.3](https://www.rfc-editor.org/rfc/rfc8291.html#section-3.3) | `HKDF` deriveBits (or `HMAC`) | Yes |
| Single-record `aes128gcm` ([RFC 8188](https://www.rfc-editor.org/rfc/rfc8188.html)); `Content-Encoding: aes128gcm`; push services need only accept 4096 octets | [RFC 8291 §4](https://www.rfc-editor.org/rfc/rfc8291.html#section-4) | `AES-GCM` encrypt | Yes |

The Cloudflare doc lists ECDSA, ECDH, HKDF, AES-GCM and HMAC as supported, including import/export ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)). No `nodejs_compat` is needed.

## 2. Why today's `web-push` should go

`server/push/webPushSender.ts` wraps `web-push@^3.6.7`, which is Node-only:

- **Transport.** `src/web-push-lib.js` imports `node:https` and `https-proxy-agent`, and sends with `https.request(...)` using the `agent` and `timeout` options ([source](https://github.com/web-push-libs/web-push/blob/master/src/web-push-lib.js)).
- **Crypto.** `src/encryption-helper.js` uses `crypto.createECDH('prime256v1')` and the `http_ece` package ([source](https://github.com/web-push-libs/web-push/blob/master/src/encryption-helper.js)).
- **Maintenance.** The latest npm release is still 3.6.7 (2024-01-16). Master has only dependency bumps since then (checked via npm registry and GitHub on 2026-09-13). The "Cloudflare Worker support?" issue [#718](https://github.com/web-push-libs/web-push/issues/718) is still open.

Cloudflare's own Agents guide *does* use `web-push` with `nodejs_compat` ([Push notifications guide](https://developers.cloudflare.com/agents/guides/push-notifications/)). `node:https` client support needs `enable_nodejs_http_modules`, which is on by default from compat date 2025-08-15 ([node:https docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/)). But the part our SSRF guard depends on does not carry over. Workers' `Agent` "is a stub implementation", and `lookup` is not among the supported request options, so `createGuardedHttpsAgent()` would silently do nothing. Keeping `web-push` means keeping a Node polyfill layer on both targets for no gain. It also contradicts the map's "single runtime over adapters" preference.

## 3. Library options (WebCrypto + `fetch`)

Data from the npm registry and GitHub API on 2026-09-13, plus a read of each published `dist/`.

| Library | Latest | Deps | Encoding | Sends itself? | JWT `exp` | Key format | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push) | 2.0.0 (2026-09-03), MIT, 44 stars | `uint8array-extras` | **`aes128gcm`** (RFC 8291) | No: `buildPushPayload(message, subscription, vapid)` returns `{ headers, method, body }` for your own `fetch` | now + 12 h | Same base64url `publicKey`/`privateKey` strings `web-push` generates | Pads to 4096 octets (max payload 3993 bytes). Default `ttl` is 60 s unless set. Includes e2e tests against real push services. |
| [`@mmmike/web-push`](https://github.com/MMMikeM/web-push) | 1.3.0 (2026-08-14), MIT, 1 star | none | **`aes128gcm`** | Yes: `sendPushNotification` / `sendPushBatch` call `fetch` with an `AbortSignal.timeout` (default 30 s) and treat 404/410 as gone | now + 12 h (configurable) | base64url | Pinned against the RFC 8291 test vector. Also ships client helpers. Very young, single maintainer. |
| [`@pushforge/builder`](https://github.com/draphy/pushforge) | 2.0.5 (2026-04-23), MIT, 63 stars | none | **`aesgcm`** (legacy draft; `Encryption:` / `Crypto-Key:` headers in `dist/lib/vapid.js`) | No: `buildPushHTTPRequest` returns `{ endpoint, headers, body }` | now + `ttl` (default 24 h, right at the RFC 8292 ceiling) | JWK | Widely referenced, but it **does not emit RFC 8291 `aes128gcm`** and its `exp` can sit at the 24 h limit. Not recommended. |
| [`web-push-browser`](https://github.com/colecrouter/web-push-browser) | 1.4.2 (2025-08-18), ISC, 2 stars | none | not verified | n/a | n/a | n/a | No release in over a year. Not evaluated further. |

**Recommendation.** Use `@block65/webcrypto-web-push`. It is RFC 8291 `aes128gcm`, actively maintained (release ten days ago), and its build-only API leaves `fetch` in our hands. That suits the SSRF options in section 4 and the existing `PushSender` seam: the `send()` adapter does the `fetch`, applies the timeout, and maps 404/410 to `gone`.

Two things to handle in the port:

- **`ttl`.** Set it explicitly, because the library's 60 s default is short.
- **Keys.** The existing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` format carries over unchanged.

The fallback is `@mmmike/web-push` if a batteries-included sender is preferred, but it has bus-factor risk. Hand-rolling is also feasible: roughly 150 lines over the primitives in section 1, testable against the RFC 8291 §5 example.

## 4. SSRF: what `fetch` actually allows

### Cloudflare (production)

- **IP literals are refused.** "For Workers subrequests, requests can only be made to URLs, not to IP addresses directly" ([Known issues](https://developers.cloudflare.com/workers/platform/known-issues/)). In practice the request fails with error 1003 ([workers-docs#981](https://github.com/cloudflare/workers-docs/issues/981)).
- **Private networks are unreachable by default.** Subrequests egress from Cloudflare's edge onto the public Internet. Reaching private resources "not accessible from the public Internet" needs an explicit [Workers VPC](https://developers.cloudflare.com/workers-vpc/) binding over a Cloudflare Tunnel. Global `fetch` has no access to the operator's LAN or a cloud metadata service.
- **The Worker never sees DNS results.** A hostname that resolves to a private address would be resolved and dialled from Cloudflare's network, not from a host with private interfaces. There is no documented way for a Worker to inspect or pin the resolved IP, and there is no need to.
- **Custom ports** are honoured since compat date 2024-09-02 (`allow_custom_ports`, [compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)). A URL guard should still require the default HTTPS port, or at least `https:`.

### workerd (Docker target)

The `workerd.capnp` schema ([source](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)) gives every Worker an implicit `internet` service as its default `globalOutbound`, with `allow = ["public"]`. The schema says: "To prevent SSRF, by default Workers will not be permitted to reach internal network addresses using global fetch()."

For hostnames, the same schema says: "these rules are used to filter the addresses returned by the lookup. If none of the returned addresses turn out to be permitted, then the system will behave as if the DNS entry did not exist." The filter runs on the resolved address actually dialled, which is exactly what `guardedLookup` does today, so DNS rebinding is covered.

The ranges come from kj's `NetworkFilter` ([`async-io.c++`](https://github.com/capnproto/capnproto/blob/v2/c++/src/kj/async-io.c%2B%2B)). `"public"` excludes:

- **Private:** `10/8`, `100.64/10`, `169.254/16`, `172.16/12`, `192.168/16`, `fc00::/7`, `fe80::/10`
- **Local:** `127/8`, `::1`, `0.0.0.0/32`, `::/128`
- **Reserved:** `192.0.0/24`, multicast, `240/4`, broadcast, `2001::/23`, `ff00::/8`

IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is matched against the IPv4 ranges ([`cidr.c++`](https://github.com/capnproto/capnproto/blob/v2/c++/src/kj/cidr.c%2B%2B), `CidrRange::matches`).

This is a superset of `isPrivateIp()` in `ssrf.ts`, with two differences:

- **Narrower `0.0.0.0` coverage.** kj blocks only `0.0.0.0/32`, where ours blocks `0/8`. Connecting to other `0/8` addresses is generally rejected by kernels anyway.
- **No NAT64.** kj has no `64:ff9b::/96` rule. That matters only if the Docker host has a NAT64 gateway.

Both can be closed with a config-level `deny` list on a custom `internet` network service. **Caveat:** this protection holds only if the Docker config keeps the default `globalOutbound`, or declares one with `allow = ["public"]`. Any `ExternalServer` or `"private"` grant added for other reasons must not become the push sender's outbound.

### Node (if the Docker image stays on Node)

Node's global `fetch` (undici) has no default address filter. The current `lookup`-based guard, or an undici `Agent` with `connect.lookup`, would still be needed. This is one more reason to prefer workerd for the Docker target.

### What the URL-level guard should check

These checks are portable, run at subscribe time and again before send, and cost nothing:

1. **Parse** with `new URL()`. Reject on failure.
2. **Scheme:** `protocol === 'https:'` ([RFC 8030 §2](https://www.rfc-editor.org/rfc/rfc8030.html#section-2) push resources are https; both block65 and mmmike enforce this too).
3. **No userinfo:** `username === ''` and `password === ''`.
4. **Default port only:** `port === ''`, which is 443.
5. **Host is not an IP literal.** Reject dotted-quad and `[...]` IPv6 hosts outright, not just private ones. Cloudflare rejects IP subrequests anyway, and real push services are hostnames. This removes the need for `embeddedIpv4` and mapped-address parsing in the URL layer.
6. **Host is not a single-label or local name:** it must contain a dot, and must not be `localhost` or end in `.localhost`, `.local`, `.internal`, or `.home.arpa`.
7. **Optional allowlist** of known push-service host suffixes, for example `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`. This is the strongest check, but a new browser vendor would need a code change. Treat it as a policy choice for the spec rather than a requirement.

Fetch options for the send:

- `redirect: 'manual'`, treating any 3xx as a failure, so a redirect can't bounce to a different host. Push services answer 201 and don't redirect.
- `signal: AbortSignal.timeout(10_000)`, replacing `SEND_TIMEOUT_MS`.

Address-level checks (rebinding, resolved private IPs) are then left to the runtime: Cloudflare's edge, or workerd's `allow = ["public"]`.

## 5. Other Workers constraints that touch push

- **Subrequest cap.** The Free plan allows 50 subrequests per invocation and 6 simultaneous outbound connections ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/); the [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) confirm the 6-connection figure). A `game_over` fan-out is one subrequest per subscriber, so a handful of friends is far below the cap. Concurrency above 6 just queues.
- **CPU time.** The Free plan gives Workers 10 ms per request. Per message, the work is one ECDH `generateKey` + `deriveBits`, a few HKDF calls, AES-GCM on under 4 KB, and one ECDSA sign. That is native WebCrypto, not JS, so it should be well under a millisecond per recipient, though this was not benchmarked here. Durable Objects reset CPU time per incoming request or WebSocket message.
- **Fire-and-forget.** `notifier.ts` isn't awaited by the transport. In a Worker, the push must run inside `ctx.waitUntil(...)` or inside the Durable Object's own request/alarm handling, or it may be cut off.

## 6. Mapping onto `server/push/`

| File | Change on the new runtime |
| --- | --- |
| `notifier.ts` | Unchanged. The `PushSender` seam already isolates delivery. |
| `vapid.ts` | Logic unchanged. The `env` parameter type moves off `NodeJS.ProcessEnv` to a plain record, so it works with Worker `env` bindings. Key format stays compatible with block65. |
| `webPushSender.ts` | Rewrite: `buildPushPayload` + `fetch(endpoint, { ...payload, redirect: 'manual', signal: AbortSignal.timeout(...) })`, mapping 404/410 to `gone`. |
| `ssrf.ts` | Drop `guardedLookup` / `createGuardedHttpsAgent` and the `node:dns` / `node:https` imports. Keep a pure `isSafePushEndpoint(url)` with the section 4 checks. The IP-classification helpers can be deleted if IP literals are rejected outright. |
| `subscriptions.ts` | Out of scope here (storage research). |

## Open questions surfaced

1. **Docker runtime choice.** workerd vs Node decides whether address-level SSRF protection is free (workerd `globalOutbound`) or needs an undici `connect.lookup` guard (Node). Belongs with the runtime/Docker ticket.
2. **Push-host allowlist?** Should `isSafePushEndpoint` pin known push-service hostnames, or only apply the structural checks? This is a security-policy decision for the spec.
3. **Unmeasured costs.** WebCrypto push-encryption CPU cost on the Free plan's 10 ms budget, and whether push fan-out runs in the Durable Object or a Worker with `waitUntil`, are unverified. A quick benchmark in `wrangler dev` or a deployed Worker would settle it.
