/**
 * Hot, per-game live position state — the latest reported position of every
 * player in a game. This is the ephemeral half of the split-state model (see
 * docs/arc42.md §5, ADR-004): live positions live in Redis; durable history is
 * flushed to PostgreSQL by the persistence layer.
 */

/** A player's latest reported position. */
export interface Position {
  lat: number;
  lng: number;
  /** When the client reported it (ISO-8601). */
  recordedAt: string;
}

/** Latest position per player id, for one game. */
export type PositionsByPlayer = Record<string, Position>;

/** Reads and writes the hot live-position state for games. */
export interface PositionStore {
  /** Record a player's latest position for a game (called on each tick). */
  writePosition(gameId: string, playerId: string, pos: Position): Promise<void>;
  /** Read every player's latest position for a game. */
  readPositions(gameId: string): Promise<PositionsByPlayer>;
}

/**
 * The subset of a Redis client the position store uses. Kept minimal so a fake
 * client can drive the store in tests without a live Redis.
 */
export interface RedisHashClient {
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<number>;
}

/** Redis key holding the latest position of every player in a game. */
export function positionsKey(gameId: string): string {
  return `game:${gameId}:positions`;
}

/**
 * Time-to-live for a game's hot position state. Live state is ephemeral, so the
 * key self-expires a while after the last write, keeping abandoned games from
 * lingering in Redis; each write refreshes it.
 */
export const POSITIONS_TTL_S = 60 * 60 * 6; // 6 hours

/**
 * Store live positions in a Redis hash keyed per game: one field per player id
 * holding the JSON-encoded latest position. Every write refreshes the key TTL.
 */
export function createRedisPositionStore(
  redis: RedisHashClient,
  ttlSeconds: number = POSITIONS_TTL_S,
): PositionStore {
  return {
    async writePosition(gameId, playerId, pos) {
      const key = positionsKey(gameId);
      await redis.hset(key, playerId, JSON.stringify(pos));
      await redis.expire(key, ttlSeconds);
    },
    async readPositions(gameId) {
      const raw = await redis.hgetall(positionsKey(gameId));
      const positions: PositionsByPlayer = {};
      for (const [playerId, value] of Object.entries(raw)) {
        positions[playerId] = JSON.parse(value) as Position;
      }
      return positions;
    },
  };
}

/**
 * In-process position store used when Redis is not configured (dev, tests, a
 * single instance). Same contract as the Redis store, minus cross-instance
 * sharing and TTL.
 */
export function createMemoryPositionStore(): PositionStore {
  const games = new Map<string, Map<string, Position>>();
  return {
    async writePosition(gameId, playerId, pos) {
      let game = games.get(gameId);
      if (!game) {
        game = new Map<string, Position>();
        games.set(gameId, game);
      }
      game.set(playerId, pos);
    },
    async readPositions(gameId) {
      return Object.fromEntries(games.get(gameId) ?? new Map<string, Position>());
    },
  };
}
