/**
 * Password hashing for account sign-in (BACKLOG.md #20).
 *
 * Passwords are never stored or compared in the clear. Each is salted and run
 * through **scrypt** — a deliberately slow, memory-hard KDF from Node's built-in
 * `crypto`, so no third-party dependency is pulled in for a security-critical
 * primitive. The stored value is self-describing:
 *
 *     scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>
 *
 * carrying the cost parameters used at hash time, so they can be tuned later
 * without invalidating existing hashes — {@link verifyPassword} re-derives with
 * the parameters embedded in the stored string, not today's defaults.
 *
 * Verification is constant-time (`timingSafeEqual`) and never throws on a
 * malformed stored value: a hash it can't parse simply fails to verify, so a
 * corrupt row can't crash a sign-in or, worse, be coerced into matching.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt cost parameters. `N` (CPU/memory cost) is the dominant knob; 2^15 with
 * r=8, p=1 is a common interactive-login target that stays well under a phone's
 * patience while being expensive to brute-force. `keylen` is the derived-key
 * length in bytes.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

/**
 * scrypt needs a `maxmem` above its default 32 MiB once N·r·p·128 grows past it;
 * derive a headroom-padded ceiling from the parameters so a higher cost doesn't
 * trip `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
 */
function maxmemFor(n: number, r: number, p: number): number {
  return Math.max(32 * 1024 * 1024, 256 * n * r * p);
}

/** Promisified scrypt returning the derived key for the given parameters. */
function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: n, r, p, maxmem: maxmemFor(n, r, p) },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * Hash a password into a self-describing, storable string. A fresh random salt
 * is drawn per call, so identical passwords never yield identical hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash produced by {@link hashPassword}.
 * Returns `false` — never throws — for a wrong password or a hash string this
 * function can't parse, so a malformed row fails closed instead of crashing the
 * caller or being tricked into a match.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64url');
    expected = Buffer.from(parts[5] as string, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p, expected.length);
  } catch {
    return false;
  }
  // Equal lengths by construction (we derive `expected.length` bytes), but guard
  // anyway — timingSafeEqual throws on a length mismatch.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
