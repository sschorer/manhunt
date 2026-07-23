import { describe, expect, it } from 'vitest';
import { createSubscriptionStore, type PushSubscription } from './subscriptions.ts';

function sub(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: 'p', auth: 'a' } };
}

describe('createSubscriptionStore', () => {
  it('stores and reads back a player subscription', () => {
    const store = createSubscriptionStore();
    store.add('g1', 'p1', sub('e1'));
    expect(store.get('g1', 'p1')).toEqual(sub('e1'));
  });

  it('keeps one subscription per player — a re-subscribe replaces the old one', () => {
    const store = createSubscriptionStore();
    store.add('g1', 'p1', sub('old'));
    store.add('g1', 'p1', sub('new'));
    expect(store.get('g1', 'p1')?.endpoint).toBe('new');
    expect(store.forGame('g1')).toHaveLength(1);
  });

  it('lists every opted-in player in a game', () => {
    const store = createSubscriptionStore();
    store.add('g1', 'p1', sub('e1'));
    store.add('g1', 'p2', sub('e2'));
    store.add('g2', 'p3', sub('e3'));
    const g1 = store.forGame('g1').map((s) => s.playerId).sort();
    expect(g1).toEqual(['p1', 'p2']);
  });

  it('returns undefined / empty for unknown games and players', () => {
    const store = createSubscriptionStore();
    expect(store.get('nope', 'p1')).toBeUndefined();
    expect(store.forGame('nope')).toEqual([]);
  });

  it('removes a single player without touching the rest', () => {
    const store = createSubscriptionStore();
    store.add('g1', 'p1', sub('e1'));
    store.add('g1', 'p2', sub('e2'));
    store.remove('g1', 'p1');
    expect(store.get('g1', 'p1')).toBeUndefined();
    expect(store.get('g1', 'p2')).toEqual(sub('e2'));
  });

  it('forgets an entire game', () => {
    const store = createSubscriptionStore();
    store.add('g1', 'p1', sub('e1'));
    store.add('g1', 'p2', sub('e2'));
    store.removeGame('g1');
    expect(store.forGame('g1')).toEqual([]);
  });

  describe('removeIfEndpoint', () => {
    it('drops the subscription when the endpoint matches', () => {
      const store = createSubscriptionStore();
      store.add('g1', 'p1', sub('gone'));
      store.removeIfEndpoint('g1', 'p1', 'gone');
      expect(store.get('g1', 'p1')).toBeUndefined();
    });

    it('leaves a newer subscription in place when the endpoint differs', () => {
      const store = createSubscriptionStore();
      store.add('g1', 'p1', sub('gone'));
      // Player re-subscribed with a fresh endpoint after a send began.
      store.add('g1', 'p1', sub('fresh'));
      store.removeIfEndpoint('g1', 'p1', 'gone');
      expect(store.get('g1', 'p1')?.endpoint).toBe('fresh');
    });

    it('is a no-op for an unknown player', () => {
      const store = createSubscriptionStore();
      expect(() => store.removeIfEndpoint('g1', 'p1', 'e1')).not.toThrow();
    });
  });
});
