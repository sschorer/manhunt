/**
 * The VAPID key pair: generating one, and resolving the one a deployment is
 * configured with. VAPID (RFC 8292) is how a push service knows which
 * application server asked it to deliver a notification: the request carries a
 * JWT signed with this private key, plus a contact `subject` for the operator.
 *
 * A Cloudflare deployment and any Docker deployment are independent
 * installations with their own pair (ADR 0005, `docs/specs/cloudflare-and-docker-migration.md`):
 * on Cloudflare the keys are `wrangler secret put` secrets and `VAPID_SUBJECT` is
 * a Worker variable; on Docker all three come from the container's environment.
 *
 * Web Push is optional. Without both keys, or without a real contact subject, it
 * stays off: `/api/push/vapid-public-key` answers `null`, the client hides its
 * notification toggle, and nothing is ever pushed.
 */

/** A resolved key pair with the contact subject its JWT carries. */
export interface VapidKeys {
  /** The application-server public key (base64url), also handed to the client. */
  publicKey: string;
  /** The private key (base64url) that signs the VAPID JWT. It never leaves the server. */
  privateKey: string;
  /** The `sub` claim: a `mailto:` or `https:` URI the push service can contact. */
  subject: string;
}

/**
 * The variables the keys come in on. On Cloudflare they are secrets and a
 * variable; on the Docker target they are workerd `fromEnvironment` bindings,
 * which bind to null when the operator didn't set them.
 */
export interface VapidVariables {
  VAPID_PUBLIC_KEY?: string | null;
  VAPID_PRIVATE_KEY?: string | null;
  VAPID_SUBJECT?: string | null;
}

/** A `sub` claim is only ever a `mailto:` or `https:` URI; push services reject anything else. */
function isContactSubject(subject: string): boolean {
  return subject.startsWith('mailto:') || subject.startsWith('https:');
}

function configured(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The VAPID configuration a deployment is running with, or `undefined` — push off.
 * Both keys are required, so a half-configured pair can never produce a broken
 * signer, and so is a real contact subject: a deployment with keys but no way to
 * be contacted has push turned off on purpose, and says so once, rather than
 * signing with a placeholder every push service is free to reject.
 */
export function resolveVapid(vars: VapidVariables): VapidKeys | undefined {
  const publicKey = configured(vars.VAPID_PUBLIC_KEY);
  const privateKey = configured(vars.VAPID_PRIVATE_KEY);
  if (!publicKey || !privateKey) return undefined;
  const subject = configured(vars.VAPID_SUBJECT);
  if (!subject || !isContactSubject(subject)) {
    // Never the keys themselves: this is the one place that has both.
    console.warn(JSON.stringify({ event: 'vapid_subject_missing' }));
    return undefined;
  }
  return { publicKey, privateKey, subject };
}

/** Bytes as base64url, the encoding every key in Web Push is carried in. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a VAPID key pair with WebCrypto, in the base64url form the push
 * protocol and `@block65/webcrypto-web-push` read: the public key as the
 * uncompressed P-256 point the `Authorization` header carries, the private key as
 * the JWK `d` coordinate that signs the JWT. Run through `npm run vapid:keys`.
 */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  // Node's lib and @cloudflare/workers-types describe WebCrypto's return types
  // differently, and this module is checked against both; hence the shapes here.
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const { d } = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d?: string };
  if (!d) throw new Error('WebCrypto returned a private key without its d coordinate');
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { publicKey: base64url(raw), privateKey: d };
}
