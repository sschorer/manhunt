import { Redis } from 'ioredis';

let client: Redis | undefined;
let subscriber: Redis | undefined;

/** Whether a Redis connection is configured (via `REDIS_URL`). */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Build a lazily-connecting ioredis client from `REDIS_URL`.
 *
 * `lazyConnect` mirrors the database pool: constructing the client never opens
 * a socket, so importing this module (or a bare dev checkout without Redis)
 * pays nothing until the first command. Connection trouble surfaces as `error`
 * events, which ioredis retries internally — we attach a listener so Node does
 * not treat them as unhandled.
 */
function connect(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set — cannot connect to Redis');
  }
  const redis = new Redis(url, { lazyConnect: true });
  redis.on('error', (err: Error) => console.error('redis error:', err.message));
  return redis;
}

/**
 * The shared connection used for commands and publishing. Lazily created on
 * first use and reused thereafter.
 */
export function getRedis(): Redis {
  if (!client) client = connect();
  return client;
}

/**
 * The dedicated subscriber connection. A Redis connection in subscribe mode can
 * only issue (p)subscribe/unsubscribe commands, so pub/sub needs its own
 * connection separate from {@link getRedis}.
 */
export function getSubscriber(): Redis {
  if (!subscriber) subscriber = connect();
  return subscriber;
}

/** Close any open Redis connections. Safe to call when none were created. */
export async function closeRedis(): Promise<void> {
  const open = [client, subscriber].filter((c): c is Redis => Boolean(c));
  client = undefined;
  subscriber = undefined;
  // quit() rejects on a never-connected lazyConnect client; ignore that.
  await Promise.all(open.map((c) => c.quit().catch(() => {})));
}
