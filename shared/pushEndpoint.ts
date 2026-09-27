/**
 * The one check a push endpoint has to pass: at `push_subscribe`, before it is
 * stored on a Seat, and again before every send. The server makes an outbound
 * request to whatever it is handed here, so an unchecked endpoint is a client
 * steering the server's `fetch` wherever it likes (SSRF).
 *
 * It lives in `shared/` because `validatePushSubscription` is the validator both
 * backends run on an inbound `push_subscribe`, and one endpoint policy beats two.
 *
 * Both runtimes refuse the addresses underneath this — Cloudflare doesn't dial IP
 * literals and only leaves its edge onto the public Internet; workerd filters the
 * resolved addresses to public ranges, with the extra `deny` rules in
 * `deploy/config.capnp` under it. So this layer is purely about the URL, and the
 * allowlist is what makes it strict: a browser's subscription always points at
 * its vendor's push service, and nothing else is worth dialling.
 */

/**
 * The push services browsers subscribe to. A `*.` entry matches any subdomain of
 * that suffix, but never the suffix on its own. Supporting a new browser vendor
 * is a deliberate code change (see `docs/specs/cloudflare-and-docker-migration.md`).
 */
export const PUSH_SERVICE_HOSTS = [
  // Chrome and Android
  'fcm.googleapis.com',
  // Firefox
  '*.push.services.mozilla.com',
  // Safari and iOS
  '*.push.apple.com',
  // Edge
  '*.notify.windows.com',
] as const;

/** Suffixes that name something on the local network rather than a push service. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** Whether `host` is one of {@link PUSH_SERVICE_HOSTS}, or a subdomain of a `*.` entry. */
function isKnownPushService(host: string): boolean {
  return PUSH_SERVICE_HOSTS.some((allowed) =>
    allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed,
  );
}

/**
 * Whether a host is an IP literal. Every form of one is rejected, not just the
 * private ranges: a real push service is a hostname, so an address here is
 * either a mistake or an attempt to reach something that isn't a push service.
 */
function isIpLiteral(host: string): boolean {
  // The URL parser keeps an IPv6 literal in its brackets.
  return host.startsWith('[') || /^[\d.]+$/.test(host);
}

/**
 * Whether an endpoint is one of the push services we deliver to, reachable the
 * only way a push resource is (RFC 8030 §2): `https` on its default port.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // An empty `port` is the scheme's default, which for https is 443.
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIpLiteral(host) || !host.includes('.')) return false;
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return isKnownPushService(host);
}
