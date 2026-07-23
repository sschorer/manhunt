/**
 * VAPID (Voluntary Application Server Identification) configuration for Web Push
 * (BACKLOG.md #23). A push service (FCM, Mozilla, Apple) authenticates the server
 * that asks it to deliver a notification via a signed VAPID JWT; the key pair
 * that signs it — and the contact `subject` embedded in it — is the config this
 * module resolves from the environment.
 *
 * Web Push is **optional**: with no keys configured the feature is simply off —
 * the server advertises no public key, so a client never tries to subscribe, and
 * nothing is ever pushed. Generate a key pair with
 * `npx web-push generate-vapid-keys` and set `VAPID_PUBLIC_KEY` /
 * `VAPID_PRIVATE_KEY` (see `.env.example`) to turn it on.
 */

/** A resolved VAPID key pair plus the contact subject the JWT carries. */
export interface VapidConfig {
  /** The application-server public key (base64url), also handed to the client. */
  publicKey: string;
  /** The private key (base64url) that signs the VAPID JWT. Never leaves the server. */
  privateKey: string;
  /**
   * The `sub` claim: a `mailto:` or `https:` URI the push service can use to
   * contact the operator. Push services reject a subject that is neither.
   */
  subject: string;
}

/** A `sub` claim is only valid as a `mailto:` or `https:` URI. */
function isValidSubject(subject: string): boolean {
  return subject.startsWith('mailto:') || subject.startsWith('https:');
}

/**
 * Default contact subject when `VAPID_SUBJECT` is unset. A `mailto:` placeholder
 * keeps the JWT well-formed; operators should override it with a real contact.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@example.com';

/**
 * Resolve the VAPID configuration from the environment. Returns `undefined` —
 * Web Push disabled — unless **both** `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
 * are present and non-empty, so a half-configured pair can never yield a broken
 * signer. `VAPID_SUBJECT` supplies the contact URI (falling back to
 * {@link DEFAULT_VAPID_SUBJECT}); a subject that is neither `mailto:` nor
 * `https:` is ignored in favour of the default rather than producing a JWT the
 * push service would reject.
 */
export function resolveVapidConfig(
  env: NodeJS.ProcessEnv = process.env,
): VapidConfig | undefined {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return undefined;
  const configured = env.VAPID_SUBJECT?.trim();
  const subject = configured && isValidSubject(configured) ? configured : DEFAULT_VAPID_SUBJECT;
  return { publicKey, privateKey, subject };
}
