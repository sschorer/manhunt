/**
 * The live (hot) state layer: a per-game position store plus a cross-instance
 * broadcaster. Backed by Redis when `REDIS_URL` is set, and by an in-process
 * fallback otherwise so a bare dev checkout and CI (which have no Redis
 * service) still run as a single instance.
 */
import { closeRedis, getRedis, getSubscriber, isRedisConfigured } from '../redis/client.ts';
import {
  createMemoryPositionStore,
  createRedisPositionStore,
  type PositionStore,
} from './positions.ts';
import {
  createLocalBroadcaster,
  createRedisBroadcaster,
  type Broadcaster,
} from './broadcaster.ts';

export * from './positions.ts';
export * from './broadcaster.ts';
export * from './tick.ts';
export * from './boundary.ts';
export * from './catch.ts';
export * from './ping.ts';

/** The hot-state layer wired into the server. */
export interface LiveState {
  store: PositionStore;
  broadcaster: Broadcaster;
  /** Release the broadcaster and any underlying Redis connections. */
  close(): Promise<void>;
}

/**
 * Build the live-state layer. With `REDIS_URL` set it shares hot positions and
 * fans out over pub/sub — the shape a multi-instance deployment needs. Without
 * it, an in-process store and loopback broadcaster keep a single instance fully
 * functional.
 */
export function createLiveState(): LiveState {
  if (isRedisConfigured()) {
    const pub = getRedis();
    const sub = getSubscriber();
    const broadcaster = createRedisBroadcaster(pub, sub);
    return {
      store: createRedisPositionStore(pub),
      broadcaster,
      async close() {
        await broadcaster.close();
        await closeRedis();
      },
    };
  }

  const broadcaster = createLocalBroadcaster();
  return {
    store: createMemoryPositionStore(),
    broadcaster,
    close: () => broadcaster.close(),
  };
}
