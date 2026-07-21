import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_PATTERN,
  createLocalBroadcaster,
  createRedisBroadcaster,
  stateChannel,
  type GameStateMessage,
  type RedisPublisher,
  type RedisSubscriber,
} from './broadcaster.ts';

type PMessageListener = (pattern: string, channel: string, message: string) => void;

interface FakePubSub extends RedisPublisher, RedisSubscriber {
  published: Array<{ channel: string; message: string }>;
  patterns: string[];
  /** Simulate a message arriving on the wire. */
  deliver(channel: string, message: string): void;
}

/** A fake Redis pair wired so publishing loops back through the subscriber. */
function fakePubSub(): FakePubSub {
  const published: Array<{ channel: string; message: string }> = [];
  const patterns: string[] = [];
  let listener: PMessageListener | undefined;
  return {
    published,
    patterns,
    async publish(channel, message) {
      published.push({ channel, message });
      return 1;
    },
    async psubscribe(pattern) {
      patterns.push(pattern);
      return 1;
    },
    on(_event, cb) {
      listener = cb;
      return this;
    },
    deliver(channel, message) {
      listener?.(CHANNEL_PATTERN, channel, message);
    },
  };
}

const message = (gameId: string): GameStateMessage => ({
  gameId,
  positions: { p1: { lat: 1, lng: 2, recordedAt: '2026-07-21T00:00:00.000Z' } },
});

describe('stateChannel', () => {
  it('namespaces the channel per game and matches the pattern shape', () => {
    expect(stateChannel('ABCD')).toBe('game:ABCD:state');
    expect(CHANNEL_PATTERN).toBe('game:*:state');
  });
});

describe('createRedisBroadcaster', () => {
  it('publishes JSON on the game channel', async () => {
    const redis = fakePubSub();
    const broadcaster = createRedisBroadcaster(redis, redis);
    await broadcaster.publish(message('g1'));

    expect(redis.published).toEqual([
      { channel: 'game:g1:state', message: JSON.stringify(message('g1')) },
    ]);
  });

  it('subscribes to the channel pattern once and dispatches decoded messages', async () => {
    const redis = fakePubSub();
    const broadcaster = createRedisBroadcaster(redis, redis);

    const a = vi.fn();
    const b = vi.fn();
    broadcaster.subscribe(a);
    broadcaster.subscribe(b);
    // Give the fire-and-forget psubscribe a chance to settle.
    await Promise.resolve();

    // Only one network subscription regardless of handler count.
    expect(redis.patterns).toEqual([CHANNEL_PATTERN]);

    redis.deliver('game:g1:state', JSON.stringify(message('g1')));
    expect(a).toHaveBeenCalledWith(message('g1'));
    expect(b).toHaveBeenCalledWith(message('g1'));
  });

  it('delivers a published message to subscribers via the subscriber loopback', async () => {
    const redis = fakePubSub();
    const broadcaster = createRedisBroadcaster(redis, redis);
    const handler = vi.fn();
    broadcaster.subscribe(handler);

    await broadcaster.publish(message('g7'));
    // Emulate Redis routing the publish back to pattern subscribers.
    const { channel, message: payload } = redis.published[0]!;
    redis.deliver(channel, payload);

    expect(handler).toHaveBeenCalledWith(message('g7'));
  });

  it('stops dispatching after close', async () => {
    const redis = fakePubSub();
    const broadcaster = createRedisBroadcaster(redis, redis);
    const handler = vi.fn();
    broadcaster.subscribe(handler);
    await broadcaster.close();

    redis.deliver('game:g1:state', JSON.stringify(message('g1')));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createLocalBroadcaster', () => {
  it('delivers published messages to every local subscriber', async () => {
    const broadcaster = createLocalBroadcaster();
    const a = vi.fn();
    const b = vi.fn();
    broadcaster.subscribe(a);
    broadcaster.subscribe(b);

    await broadcaster.publish(message('g1'));
    expect(a).toHaveBeenCalledWith(message('g1'));
    expect(b).toHaveBeenCalledWith(message('g1'));
  });

  it('stops delivering after close', async () => {
    const broadcaster = createLocalBroadcaster();
    const handler = vi.fn();
    broadcaster.subscribe(handler);
    await broadcaster.close();

    await broadcaster.publish(message('g1'));
    expect(handler).not.toHaveBeenCalled();
  });
});
