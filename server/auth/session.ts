/**
 * Signed session tokens (BACKLOG.md #20).
 *
 * A session is **stateless**: rather than keeping a server-side session table,
 * the account id is packed into a compact token and signed with an HMAC keyed by
 * `SESSION_SECRET` (the env var the deploy already provisions — see
 * `.env.example` and docs/arc42.md §7). The server trusts a token only if the
 * signature verifies and it hasn't expired, so nothing that reaches it from a
 * cookie is believed without the key it can't forge.
 *
 *     v1.<payloadB64url>.<sigB64url>
 *
 * where the payload is `{ sub, iat, exp }` (account id, issued-at, expiry — epoch
 * seconds) and the signature is `HMAC-SHA256(secret, "v1.<payloadB64url>")`.
 * Verification is constant-time and never throws: a garbled, tampered, or expired
 * token simply resolves to `null` and the request is treated as anonymous.
 *
 * Stateless tokens can't be individually revoked; rotating `SESSION_SECRET`
 * invalidates every outstanding session at once, which is the intended blunt
 * lever for a small self-hosted deployment. Durable, revocable sessions are a
 * later concern.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token version prefix, so the format can evolve without misreading old tokens. */
const VERSION = 'v1';

/** Default session lifetime: 30 days, in seconds. */
export const DEFAULT_SESSION_TTL_S = 30 * 24 * 60 * 60;

/** The decoded, verified contents of a session token. */
export interface SessionClaims {
  /** The authenticated account id. */
  accountId: string;
  /** Issued-at, epoch seconds. */
  issuedAt: number;
  /** Expiry, epoch seconds. */
  expiresAt: number;
}

/** Mints and verifies session tokens for one signing secret + lifetime. */
export interface SessionCodec {
  /** Sign a token for `accountId`, valid for the configured TTL from now. */
  sign(accountId: string): string;
  /** Verify a token, returning its claims, or `null` if invalid/expired. */
  verify(token: string | undefined | null): SessionClaims | null;
  /** The cookie max-age (seconds) callers should set, matching the token TTL. */
  readonly ttlSeconds: number;
}

interface CodecOptions {
  /**
   * HMAC signing key. Defaults to `SESSION_SECRET`; when that is unset a random
   * per-process secret is generated (with a warning) so dev still works, at the
   * cost of every session being invalidated on restart.
   */
  secret?: string;
  /** Session lifetime in seconds. Defaults to {@link DEFAULT_SESSION_TTL_S}. */
  ttlSeconds?: number;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the HMAC secret. An explicit value wins; otherwise `SESSION_SECRET`;
 * otherwise a random ephemeral secret is minted and a warning logged, since a
 * missing secret must never silently disable signing.
 */
export function resolveSessionSecret(
  raw: string | undefined = process.env.SESSION_SECRET,
): string {
  if (raw && raw.trim() !== '') return raw;
  console.warn(
    'SESSION_SECRET is not set — using a random per-process secret; ' +
      'sessions will not survive a restart. Set SESSION_SECRET in production.',
  );
  return randomBytes(32).toString('base64url');
}

/** Constant-time string compare that tolerates unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Build a {@link SessionCodec} over a signing secret and lifetime. */
export function createSessionCodec({
  secret = resolveSessionSecret(),
  ttlSeconds = DEFAULT_SESSION_TTL_S,
  now = Date.now,
}: CodecOptions = {}): SessionCodec {
  const sign = (payloadPart: string): string =>
    createHmac('sha256', secret).update(payloadPart).digest('base64url');

  return {
    ttlSeconds,

    sign(accountId) {
      const issuedAt = Math.floor(now() / 1000);
      const claims = { sub: accountId, iat: issuedAt, exp: issuedAt + ttlSeconds };
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const payloadPart = `${VERSION}.${body}`;
      return `${payloadPart}.${sign(payloadPart)}`;
    },

    verify(token) {
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [version, body, signature] = parts as [string, string, string];
      if (version !== VERSION) return null;
      if (!safeEqual(signature, sign(`${version}.${body}`))) return null;

      let claims: { sub?: unknown; iat?: unknown; exp?: unknown };
      try {
        claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      const { sub, iat, exp } = claims;
      if (typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') {
        return null;
      }
      if (Math.floor(now() / 1000) >= exp) return null;
      return { accountId: sub, issuedAt: iat, expiresAt: exp };
    },
  };
}
