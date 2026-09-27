/**
 * Generate a VAPID key pair for Web Push: `npm run vapid:keys`.
 *
 * Both targets need one pair per installation, and they are independent — a
 * Cloudflare deployment and a Docker deployment never share keys, because a
 * browser's subscription belongs to the origin it subscribed from.
 *
 *   Cloudflare: wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY,
 *               with VAPID_SUBJECT as a Worker variable.
 *   Docker:     all three in deploy/.env.
 *
 * Replacing the pair invalidates every subscription players have, so they have to
 * opt in again. Keep the private key out of the repo.
 */
import { generateVapidKeys } from '../server/push/keys.ts';

const { publicKey, privateKey } = await generateVapidKeys();

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('');
console.log('Set VAPID_SUBJECT to a real contact as well (mailto: or https:), or push stays off.');
