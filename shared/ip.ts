/**
 * Address classification for the Web Push SSRF guards (BACKLOG.md #23). Pure
 * string checks with no platform dependency, so both layers that block private
 * hosts use the same set:
 *
 * - **At subscribe time**, `validatePushSubscription` (`shared/validators.ts`)
 *   rejects an endpoint whose *literal* host is a private/reserved IP.
 * - **At send time**, the guarded HTTPS agent (`server/push/ssrf.ts`) rejects any
 *   hostname which *resolves* to a private/reserved address.
 */

/**
 * Whether a dotted-quad IPv4 address is in a range we never dial: loopback
 * (127/8), the unspecified address (0/8), private (10/8, 172.16/12, 192.168/16),
 * link-local (169.254/16), or carrier-grade NAT (100.64/10).
 */
export function isPrivateIpv4(dotted: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(dotted);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 literal (`::ffff:…`, which
 * the URL/DNS layer normalizes to `::ffff:HHHH:HHHH`) or a NAT64 literal
 * (`64:ff9b::…`). Returns the dotted-quad string, or `undefined` when there is no
 * embedded IPv4 — without this, `::ffff:169.254.169.254` would look like a plain
 * IPv6 host and dodge the IPv4 checks.
 */
export function embeddedIpv4(ipv6: string): string | undefined {
  const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(ipv6);
  if (!mapped) return undefined;
  const tail = mapped[1] as string;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const hi = Number.parseInt(hex[1] as string, 16);
  const lo = Number.parseInt(hex[2] as string, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

/**
 * Whether an IP address (v4 or v6, in any literal form the URL parser or DNS
 * resolver produces) is one we must never connect to. Covers IPv4 private/reserved
 * ranges (directly or embedded in an IPv4-mapped/NAT64 IPv6 literal), IPv6 loopback
 * (`::1`), the unspecified address, unique-local (`fc00::/7`), and link-local
 * (`fe80::/10`). A non-IP string (a hostname) is never "private" here.
 */
export function isPrivateIp(address: string): boolean {
  const addr = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = embeddedIpv4(addr) ?? addr;
  if (isPrivateIpv4(v4)) return true;
  if (addr === '::1' || addr === '::') return true;
  if (/^f[cd][0-9a-f]*:/.test(addr)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]*:/.test(addr)) return true; // fe80::/10 link-local
  return false;
}
