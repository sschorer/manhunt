/**
 * Cross-instance fan-out of game state. Any server instance publishes a game's
 * state; every instance (including the publisher) receives it and emits to its
 * own connected sockets. This is what lets the game run behind more than one
 * server process — the Broadcaster in docs/arc42.md §5.2, backed by Redis
 * pub/sub, with an in-process loopback for a single instance.
 */
import { EventEmitter } from 'node:events';
import type { PositionsByPlayer } from './positions.ts';

/** A room-state message fanned out to every instance for a game. */
export interface GameStateMessage {
  gameId: string;
  positions: PositionsByPlayer;
}

export type GameStateHandler = (message: GameStateMessage) => void;

/** Publish/subscribe fan-out of {@link GameStateMessage}s across instances. */
export interface Broadcaster {
  /** Publish a game's state to every subscribed instance. */
  publish(message: GameStateMessage): Promise<void>;
  /** Register a handler run for every message received (local or remote). */
  subscribe(handler: GameStateHandler): void;
  /** Tear down subscriptions/handlers. */
  close(): Promise<void>;
}

/** The publish half of a Redis client. */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/** The subscribe half of a Redis client (a dedicated subscriber connection). */
export interface RedisSubscriber {
  psubscribe(pattern: string): Promise<unknown>;
  on(
    event: 'pmessage',
    listener: (pattern: string, channel: string, message: string) => void,
  ): unknown;
}

/** Glob pattern matching every game-state channel. */
export const CHANNEL_PATTERN = 'game:*:state';

/** Redis pub/sub channel carrying a game's state. */
export function stateChannel(gameId: string): string {
  return `game:${gameId}:state`;
}

/**
 * Fan out game state across instances over Redis pub/sub. `pub` publishes on
 * the game's channel; `sub` (a dedicated subscriber connection) pattern-matches
 * every game channel and dispatches decoded messages to registered handlers.
 */
export function createRedisBroadcaster(
  pub: RedisPublisher,
  sub: RedisSubscriber,
): Broadcaster {
  const handlers = new Set<GameStateHandler>();
  let subscribed = false;

  return {
    async publish(message) {
      await pub.publish(stateChannel(message.gameId), JSON.stringify(message));
    },
    subscribe(handler) {
      handlers.add(handler);
      if (subscribed) return;
      subscribed = true;

      sub.on('pmessage', (_pattern, _channel, payload) => {
        const message = JSON.parse(payload) as GameStateMessage;
        for (const h of handlers) h(message);
      });
      // Registration is synchronous; the network subscribe settles in the
      // background so callers (e.g. server wiring) need not await it.
      void Promise.resolve(sub.psubscribe(CHANNEL_PATTERN)).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('redis psubscribe failed:', reason);
      });
    },
    async close() {
      handlers.clear();
    },
  };
}

/**
 * In-process fan-out for a single instance (dev, tests, no Redis). Publishing
 * synchronously delivers to local handlers — the loopback Redis provides across
 * instances, without the network hop.
 */
export function createLocalBroadcaster(): Broadcaster {
  const emitter = new EventEmitter();
  const EVENT = 'game_state';
  return {
    async publish(message) {
      emitter.emit(EVENT, message);
    },
    subscribe(handler) {
      emitter.on(EVENT, handler);
    },
    async close() {
      emitter.removeAllListeners(EVENT);
    },
  };
}
