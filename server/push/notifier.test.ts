import { describe, expect, it } from 'vitest';
import type { GameSummary } from '../live/outcome.ts';
import type { CatchConfirmedEvent } from '../protocol/messages.ts';
import {
  caughtPayload,
  createNotifier,
  gameOverPayload,
  revealPayload,
  type PushPayload,
  type PushSender,
  type PushSendResult,
  type RoleLookup,
} from './notifier.ts';
import { createSubscriptionStore, type PushSubscription } from './subscriptions.ts';

function sub(endpoint: string): PushSubscription {
  return { endpoint, keys: { p256dh: 'p', auth: 'a' } };
}

interface Sent {
  subscription: PushSubscription;
  payload: PushPayload;
}

/** A sender that records every delivery and returns a scripted result per endpoint. */
function fakeSender(results: Record<string, PushSendResult> = {}): PushSender & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send(subscription, payload) {
      sent.push({ subscription, payload });
      return Promise.resolve(results[subscription.endpoint] ?? { ok: true });
    },
  };
}

/** A role lookup backed by a static roster. */
function roster(map: Record<string, 'hunter' | 'hider'>): RoleLookup {
  return (_gameId, playerId) => map[playerId];
}

describe('payload builders', () => {
  it('caughtPayload carries the caught kind and a per-game tag', () => {
    const p = caughtPayload('g1');
    expect(p.data).toMatchObject({ gameId: 'g1', kind: 'caught' });
    expect(p.tag).toBe('manhunt:g1:caught');
    expect(p.title.length).toBeGreaterThan(0);
  });

  it('revealPayload carries the reveal kind', () => {
    expect(revealPayload('g1').data).toMatchObject({ gameId: 'g1', kind: 'reveal' });
  });

  it('gameOverPayload reflects the winner', () => {
    const base: GameSummary = {
      gameId: 'g1',
      winner: 'hunters',
      reason: 'all_caught',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:10:00.000Z',
      durationMs: 600_000,
      catches: [],
      hiders: [],
    };
    expect(gameOverPayload(base).data).toMatchObject({ winner: 'hunters', kind: 'game_over' });
    expect(gameOverPayload({ ...base, winner: 'hiders', reason: 'timer' }).body).toMatch(/hiders/i);
    expect(gameOverPayload(base).body).toMatch(/hunters/i);
  });
});

const catchEvent = (targetId: string): CatchConfirmedEvent => ({
  gameId: 'g1',
  hunterId: 'h1',
  targetId,
  at: '2026-01-01T00:05:00.000Z',
});

describe('createNotifier', () => {
  describe('notifyCaught', () => {
    it('pushes only to the caught player', async () => {
      const store = createSubscriptionStore();
      store.add('g1', 'victim', sub('victim-ep'));
      store.add('g1', 'other', sub('other-ep'));
      const sender = fakeSender();
      const notifier = createNotifier({ store, sender, roleOf: roster({}) });

      await notifier.notifyCaught('g1', catchEvent('victim'));

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]?.subscription.endpoint).toBe('victim-ep');
      expect(sender.sent[0]?.payload.data.kind).toBe('caught');
    });

    it('is a no-op when the caught player never opted in', async () => {
      const store = createSubscriptionStore();
      const sender = fakeSender();
      const notifier = createNotifier({ store, sender, roleOf: roster({}) });

      await notifier.notifyCaught('g1', catchEvent('victim'));

      expect(sender.sent).toHaveLength(0);
    });
  });

  describe('notifyReveal', () => {
    it('pushes to hunters only', async () => {
      const store = createSubscriptionStore();
      store.add('g1', 'hunter1', sub('hunter1-ep'));
      store.add('g1', 'hider1', sub('hider1-ep'));
      const sender = fakeSender();
      const notifier = createNotifier({
        store,
        sender,
        roleOf: roster({ hunter1: 'hunter', hider1: 'hider' }),
      });

      await notifier.notifyReveal('g1');

      expect(sender.sent.map((s) => s.subscription.endpoint)).toEqual(['hunter1-ep']);
      expect(sender.sent[0]?.payload.data.kind).toBe('reveal');
    });

    it('routes by the current role — a caught hider now hunting gets the reveal', async () => {
      const store = createSubscriptionStore();
      store.add('g1', 'flipped', sub('flipped-ep'));
      const sender = fakeSender();
      // The player subscribed as a hider but has since been caught and flipped.
      const notifier = createNotifier({ store, sender, roleOf: roster({ flipped: 'hunter' }) });

      await notifier.notifyReveal('g1');

      expect(sender.sent).toHaveLength(1);
    });
  });

  describe('notifyGameOver', () => {
    it('pushes to everyone subscribed in the game', async () => {
      const store = createSubscriptionStore();
      store.add('g1', 'p1', sub('p1-ep'));
      store.add('g1', 'p2', sub('p2-ep'));
      store.add('g2', 'p3', sub('p3-ep'));
      const sender = fakeSender();
      const notifier = createNotifier({ store, sender, roleOf: roster({}) });

      const summary = { gameId: 'g1', winner: 'hiders', reason: 'timer' } as GameSummary;
      await notifier.notifyGameOver(summary);

      expect(sender.sent.map((s) => s.subscription.endpoint).sort()).toEqual(['p1-ep', 'p2-ep']);
    });
  });

  describe('pruning gone subscriptions', () => {
    it('drops a subscription the push service reports gone (404/410)', async () => {
      const store = createSubscriptionStore();
      store.add('g1', 'victim', sub('dead-ep'));
      const sender = fakeSender({ 'dead-ep': { ok: false, gone: true } });
      const notifier = createNotifier({ store, sender, roleOf: roster({}) });

      await notifier.notifyCaught('g1', catchEvent('victim'));

      expect(store.get('g1', 'victim')).toBeUndefined();
    });

    it('keeps a subscription after a transient (non-gone) failure', async () => {
      const store = createSubscriptionStore();
      store.add('g1', 'victim', sub('flaky-ep'));
      const sender = fakeSender({ 'flaky-ep': { ok: false } });
      const notifier = createNotifier({ store, sender, roleOf: roster({}) });

      await notifier.notifyCaught('g1', catchEvent('victim'));

      expect(store.get('g1', 'victim')?.endpoint).toBe('flaky-ep');
    });
  });
});
