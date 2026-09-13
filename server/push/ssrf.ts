/**
 * SSRF guards for the Web Push sender (BACKLOG.md #23). Two layers use these:
 *
 * - **At subscribe time**, `validatePushSubscription` (in
 *   `shared/validators.ts`) rejects an endpoint whose *literal* host is a
 *   private/reserved IP, so an obviously-crafted subscription never gets stored.
 * - **At send time**, {@link createGuardedHttpsAgent} plugs a DNS `lookup` into
 *   the outbound HTTPS request that rejects any hostname which *resolves* to a
 *   private/reserved address — closing the DNS-rebinding gap where a public-looking
 *   hostname points at loopback/RFC1918/link-local space (e.g. cloud metadata).
 *
 * The address classification (`shared/ip.ts`) is shared between the two so both layers block the
 * same set. Real Web Push endpoints are always the browser vendor's public push
 * service, so none of this affects legitimate traffic.
 */
import dns from 'node:dns';
import https from 'node:https';
import type net from 'node:net';
import { embeddedIpv4, isPrivateIp, isPrivateIpv4 } from '../../shared/ip.ts';

export { embeddedIpv4, isPrivateIp, isPrivateIpv4 };

/**
 * A `dns.lookup` drop-in (a {@link net.LookupFunction}) that resolves as usual but
 * fails the connection if the resolved address is private/reserved. Because the
 * socket connects to the exact address this returns, validating here closes the
 * TOCTOU/DNS-rebinding window (there is no second, unchecked resolution). Honors
 * the `all` option shape (an array of addresses).
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address, family);
      return;
    }
    const entries: dns.LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address, family }];
    const blocked = entries.find((entry) => isPrivateIp(entry.address));
    if (blocked) {
      callback(
        Object.assign(new Error(`blocked non-public push endpoint address: ${blocked.address}`), {
          code: 'EBLOCKEDADDR',
        }),
        address,
        family,
      );
      return;
    }
    callback(null, address, family);
  });
};

/**
 * An HTTPS agent whose DNS resolution is guarded by {@link guardedLookup}, so a
 * request to a hostname resolving into private/reserved space is refused at
 * connect time. Passed to `web-push` as its `agent` so every push goes through it.
 */
export function createGuardedHttpsAgent(): https.Agent {
  return new https.Agent({ lookup: guardedLookup });
}
