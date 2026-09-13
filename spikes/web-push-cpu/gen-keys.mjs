// Generates throwaway VAPID and subscription keys into src/keys.json (gitignored),
// so key generation never shows up in the measured requests.
import { writeFileSync } from 'node:fs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const p256 = { name: 'ECDSA', namedCurve: 'P-256' };

const vapid = await crypto.subtle.generateKey(p256, true, ['sign', 'verify']);
const vapidJwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
const vapidRaw = await crypto.subtle.exportKey('raw', vapid.publicKey);

const client = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const clientRaw = await crypto.subtle.exportKey('raw', client.publicKey);

const keys = {
  vapid: { subject: 'mailto:spike@example.com', publicKey: b64url(vapidRaw), privateKey: vapidJwk.d },
  subscription: { p256dh: b64url(clientRaw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
};

writeFileSync(new URL('./src/keys.json', import.meta.url), JSON.stringify(keys, null, 2) + '\n');
console.log('wrote src/keys.json');
