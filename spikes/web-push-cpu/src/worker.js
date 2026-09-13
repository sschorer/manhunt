import { DurableObject } from 'cloudflare:workers';
import { buildPushPayload } from '@block65/webcrypto-web-push';
import keys from './keys.json';

// Deliberately invalid endpoint on a real push service: the CPU cost of building
// and sending a push doesn't depend on the push service accepting it, and no
// real device is ever notified.
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/manhunt-spike-invalid-endpoint';

const subscription = {
  endpoint: ENDPOINT,
  expirationTime: null,
  keys: { p256dh: keys.subscription.p256dh, auth: keys.subscription.auth },
};

const message = {
  data: JSON.stringify({ type: 'caught', gameId: 'spike', at: new Date(0).toISOString() }),
  options: { ttl: 3600 },
};

async function build(n) {
  for (let i = 0; i < n; i += 1) await buildPushPayload(message, subscription, keys.vapid);
  return { built: n };
}

async function send(n) {
  const statuses = [];
  for (let i = 0; i < n; i += 1) {
    const payload = await buildPushPayload(message, subscription, keys.vapid);
    const res = await fetch(ENDPOINT, payload);
    statuses.push(res.status);
    await res.body?.cancel();
  }
  return { sent: n, statuses };
}

function count(url) {
  return Math.max(1, Math.min(40, Number(new URL(url).searchParams.get('n')) || 1));
}

export class PushRoom extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url);
    const n = count(req.url);
    if (url.pathname === '/do/build') return Response.json({ where: 'do', ...(await build(n)) });
    if (url.pathname === '/do/send') return Response.json({ where: 'do', ...(await send(n)) });
    if (url.pathname === '/do/noop') return Response.json({ where: 'do', noop: true });
    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const n = count(req.url);
    switch (url.pathname) {
      case '/worker/noop':
        return Response.json({ where: 'worker', noop: true });
      case '/worker/build':
        return Response.json({ where: 'worker', ...(await build(n)) });
      case '/worker/send':
        return Response.json({ where: 'worker', ...(await send(n)) });
      case '/worker/waituntil':
        ctx.waitUntil(send(n));
        return Response.json({ where: 'worker-waituntil', queued: n });
      case '/do/noop':
      case '/do/build':
      case '/do/send':
        return env.PUSH_ROOM.get(env.PUSH_ROOM.idFromName('spike')).fetch(req);
      default:
        return new Response('not found', { status: 404 });
    }
  },
};
