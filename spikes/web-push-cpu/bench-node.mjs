// Local baseline: CPU time per buildPushPayload in Node on this machine.
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { readFileSync } from 'node:fs';

const keys = JSON.parse(readFileSync(new URL('./src/keys.json', import.meta.url), 'utf8'));
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/manhunt-spike-invalid-endpoint',
  expirationTime: null,
  keys: keys.subscription,
};
const message = { data: JSON.stringify({ type: 'caught', gameId: 'spike' }), options: { ttl: 3600 } };

async function measure(n) {
  const start = process.cpuUsage();
  for (let i = 0; i < n; i += 1) await buildPushPayload(message, subscription, keys.vapid);
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000 / n;
}

const coldMs = await measure(1);
await measure(50);
const warmMs = await measure(200);
console.log(`first push (cold): ${coldMs.toFixed(2)} ms CPU`);
console.log(`warm average over 200: ${warmMs.toFixed(3)} ms CPU per push`);
console.log(`CPU: ${(await import('node:os')).cpus()[0].model}`);
