import { describe, expect, it } from 'vitest';
import {
  createMemoryPositionStore,
  createRedisPositionStore,
  positionsKey,
  POSITIONS_TTL_S,
  type Position,
  type RedisHashClient,
} from './positions.ts';

interface FakeRedis extends RedisHashClient {
  hashes: Map<string, Map<string, string>>;
  expires: Array<{ key: string; seconds: number }>;
}

/** An in-memory stand-in for the hash/expire commands the store uses. */
function fakeRedis(): FakeRedis {
  const hashes = new Map<string, Map<string, string>>();
  const expires: Array<{ key: string; seconds: number }> = [];
  return {
    hashes,
    expires,
    async hset(key, field, value) {
      let hash = hashes.get(key);
      if (!hash) {
        hash = new Map();
        hashes.set(key, hash);
      }
      const isNew = hash.has(field) ? 0 : 1;
      hash.set(field, value);
      return isNew;
    },
    async hgetall(key) {
      return Object.fromEntries(hashes.get(key) ?? new Map());
    },
    async expire(key, seconds) {
      expires.push({ key, seconds });
      return hashes.has(key) ? 1 : 0;
    },
  };
}

const pos = (lat: number, lng: number): Position => ({
  lat,
  lng,
  recordedAt: '2026-07-21T00:00:00.000Z',
});

describe('positionsKey', () => {
  it('namespaces the hash per game', () => {
    expect(positionsKey('ABCD')).toBe('game:ABCD:positions');
  });
});

describe('createRedisPositionStore', () => {
  it('writes each player into the game hash and refreshes the TTL', async () => {
    const redis = fakeRedis();
    const store = createRedisPositionStore(redis);

    await store.writePosition('g1', 'p1', pos(1, 2));
    await store.writePosition('g1', 'p2', pos(3, 4));

    const key = positionsKey('g1');
    expect([...(redis.hashes.get(key)?.keys() ?? [])]).toEqual(['p1', 'p2']);
    // Every write bumps the key's expiry.
    expect(redis.expires).toEqual([
      { key, seconds: POSITIONS_TTL_S },
      { key, seconds: POSITIONS_TTL_S },
    ]);
  });

  it('reads back every player position for a game', async () => {
    const redis = fakeRedis();
    const store = createRedisPositionStore(redis);
    await store.writePosition('g1', 'p1', pos(1, 2));
    await store.writePosition('g1', 'p2', pos(3, 4));

    const positions = await store.readPositions('g1');
    expect(positions).toEqual({ p1: pos(1, 2), p2: pos(3, 4) });
  });

  it('overwrites a player with their latest position', async () => {
    const redis = fakeRedis();
    const store = createRedisPositionStore(redis);
    await store.writePosition('g1', 'p1', pos(1, 1));
    await store.writePosition('g1', 'p1', pos(9, 9));

    expect(await store.readPositions('g1')).toEqual({ p1: pos(9, 9) });
  });

  it('honors a custom TTL', async () => {
    const redis = fakeRedis();
    const store = createRedisPositionStore(redis, 42);
    await store.writePosition('g1', 'p1', pos(1, 2));
    expect(redis.expires).toEqual([{ key: positionsKey('g1'), seconds: 42 }]);
  });

  it('returns an empty map for an unknown game', async () => {
    const store = createRedisPositionStore(fakeRedis());
    expect(await store.readPositions('nope')).toEqual({});
  });
});

describe('createMemoryPositionStore', () => {
  it('stores and reads positions per game, isolated from other games', async () => {
    const store = createMemoryPositionStore();
    await store.writePosition('g1', 'p1', pos(1, 2));
    await store.writePosition('g2', 'p1', pos(5, 6));

    expect(await store.readPositions('g1')).toEqual({ p1: pos(1, 2) });
    expect(await store.readPositions('g2')).toEqual({ p1: pos(5, 6) });
    expect(await store.readPositions('g3')).toEqual({});
  });

  it('overwrites a player with their latest position', async () => {
    const store = createMemoryPositionStore();
    await store.writePosition('g1', 'p1', pos(1, 1));
    await store.writePosition('g1', 'p1', pos(2, 2));
    expect(await store.readPositions('g1')).toEqual({ p1: pos(2, 2) });
  });
});
