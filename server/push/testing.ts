/**
 * A push subscription for tests, with the browser's half of the encryption — the
 * part a real phone keeps — so a test can read what was actually delivered.
 *
 * {@link createTestSubscription} mints the P-256 key pair and auth secret a
 * browser hands the server at `push_subscribe`, and `decrypt` undoes RFC 8291
 * `aes128gcm` the way a service worker does: the shared secret from our private
 * key and the sender's public key, HKDF for the content key and nonce, then
 * AES-GCM. That makes "the push arrived" an assertion about its text rather than
 * about our own call to the library. Web standards only, so it runs both in Node
 * (`server/push/send.test.ts`) and inside workerd (the `GameRoom` push test).
 */
import type { PushSubscription } from '../../shared/index.ts';
import { base64url } from './keys.ts';

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** HKDF-SHA-256 (extract and expand in one step), as RFC 8291 uses it. */
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export interface TestSubscription {
  /** What the client would have sent as its `push_subscribe` payload. */
  subscription: PushSubscription;
  /** The payload a delivered request body carries, decrypted and parsed. */
  decrypt(body: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<unknown>;
}

/** A subscription to `endpoint` whose pushes this test can decrypt. */
export async function createTestSubscription(
  endpoint = 'https://fcm.googleapis.com/fcm/send/test-subscription',
): Promise<TestSubscription> {
  // Node's lib and @cloudflare/workers-types describe WebCrypto differently, and
  // this module is checked against both; hence the shapes and the casts here.
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
  };
  const ourPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  return {
    subscription: { endpoint, keys: { p256dh: base64url(ourPublic), auth: base64url(authSecret) } },

    async decrypt(body) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      // The aes128gcm header (RFC 8188 §2.1): salt, record size, key id length, key id.
      const salt = bytes.subarray(0, 16);
      const senderPublic = bytes.subarray(21, 21 + bytes[20]!);
      const ciphertext = bytes.subarray(21 + bytes[20]!);

      const senderKey = await crypto.subtle.importKey(
        'raw',
        senderPublic,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const ecdh = { name: 'ECDH', public: senderKey } as never;
      const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, pair.privateKey, 256));
      // RFC 8291 §3.3: the key info binds the secret to both public keys.
      const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info'), new Uint8Array([0]), ourPublic, senderPublic), 32);
      const contentKey = await hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
      const nonce = await hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12);

      const key = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['decrypt']);
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext),
      );
      // The record is padded with zeros after a delimiter byte (RFC 8188 §2).
      let end = plaintext.length;
      while (end > 0 && plaintext[end - 1] === 0) end -= 1;
      return JSON.parse(new TextDecoder().decode(plaintext.subarray(0, end - 1)));
    },
  };
}
