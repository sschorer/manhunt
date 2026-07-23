/**
 * The Web Push notifier (BACKLOG.md #23): the layer that turns a key game event
 * into a push to the right people. It owns two things — the **payloads** (what
 * each event says) and the **routing** (who hears it) — and leans on an injected
 * {@link PushSender} for the actual encrypted delivery, so the routing logic is
 * testable without a real push service or the `web-push` library.
 *
 * Three events are pushed, matching the issue (caught, reveal, time):
 *
 * - **caught** — a hider was caught. Pushed to that player, who most wants to
 *   know the instant it happens (they may have the app backgrounded).
 * - **reveal** — a scheduled ping reveal fired. Pushed to the **hunters**, whose
 *   one periodic fix on the hiders this is (mirrors the per-role filter lift in
 *   `server/app.ts`); pushing hiders their own reveal would be noise.
 * - **time** — the match ended (`game_over`). Pushed to **everyone** still
 *   subscribed, with who won, so a backgrounded player learns the result.
 *
 * Recipients are resolved live from the lobby roster (via the injected `roleOf`),
 * never from a role cached at subscribe time, so a hider who was caught and
 * flipped to a hunter is treated as the hunter they now are on the next reveal.
 * A subscription the push service reports **gone** (404/410) is pruned from the
 * store on the spot, so a stale endpoint is retried at most once.
 */
import type { GameSummary, Winner } from '../live/outcome.ts';
import type { CatchConfirmedEvent } from '../protocol/messages.ts';
import type { PushSubscription, SubscriptionStore } from './subscriptions.ts';

/** A player's authoritative role, or `undefined` when it can't be resolved. */
export type RoleLookup = (gameId: string, playerId: string) => 'hunter' | 'hider' | undefined;

/**
 * The notification payload delivered to the service worker, serialized to JSON.
 * `tag` lets the browser coalesce repeats (a second reveal replaces the first
 * rather than stacking); `data` carries structured context for the click handler.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Coalescing tag — a new notification with the same tag replaces the old one. */
  tag: string;
  /** Structured context surfaced to the service worker's notification handlers. */
  data: {
    gameId: string;
    kind: 'caught' | 'reveal' | 'game_over';
    [key: string]: unknown;
  };
}

/** The outcome of a single delivery attempt. */
export interface PushSendResult {
  ok: boolean;
  /**
   * True when the push service reported the subscription permanently gone
   * (HTTP 404/410) so the caller prunes it. Never set for a transient failure,
   * which leaves the subscription in place to be retried on the next event.
   */
  gone?: boolean;
}

/** Delivers one encrypted payload to one subscription. Injected so tests can fake it. */
export interface PushSender {
  send(subscription: PushSubscription, payload: PushPayload): Promise<PushSendResult>;
}

// --- Payload builders (pure) ------------------------------------------------

/** The push a caught hider receives. */
export function caughtPayload(gameId: string): PushPayload {
  return {
    title: "You've been caught!",
    body: "A hunter tagged you — you're on the hunt now.",
    tag: `manhunt:${gameId}:caught`,
    data: { gameId, kind: 'caught' },
  };
}

/** The push the hunters receive on a ping reveal. */
export function revealPayload(gameId: string): PushPayload {
  return {
    title: 'Hiders revealed',
    body: "A ping just exposed the hiders' positions — check the map.",
    tag: `manhunt:${gameId}:reveal`,
    data: { gameId, kind: 'reveal' },
  };
}

/** How each side's win reads to a player on the game-over push. */
function winnerLine(winner: Winner): string {
  return winner === 'hunters' ? 'The hunters win — every hider was caught.' : 'The hiders win — they survived the clock.';
}

/** The push everyone receives when the match ends. */
export function gameOverPayload(summary: GameSummary): PushPayload {
  return {
    title: 'Game over',
    body: winnerLine(summary.winner),
    tag: `manhunt:${summary.gameId}:game_over`,
    data: { gameId: summary.gameId, kind: 'game_over', winner: summary.winner, reason: summary.reason },
  };
}

// --- Notifier ---------------------------------------------------------------

export interface NotifierOptions {
  store: SubscriptionStore;
  sender: PushSender;
  /** Resolve a player's authoritative role from the lobby roster. */
  roleOf: RoleLookup;
}

/** Pushes key game events to the players who have opted in. */
export interface Notifier {
  /** Push the caught event to the caught player. */
  notifyCaught(gameId: string, event: CatchConfirmedEvent): Promise<void>;
  /** Push the reveal event to every subscribed hunter. */
  notifyReveal(gameId: string): Promise<void>;
  /** Push the game-over event to everyone subscribed in the game. */
  notifyGameOver(summary: GameSummary): Promise<void>;
}

/**
 * Build the notifier over a subscription store, a sender, and a role lookup.
 * Every `notify*` is fire-and-forget from the caller's view (the transport
 * doesn't await it), fans out to its recipients concurrently, and prunes any
 * subscription the push service reports gone. A player with no subscription is
 * simply skipped — Web Push is opt-in.
 */
export function createNotifier({ store, sender, roleOf }: NotifierOptions): Notifier {
  // Deliver one payload to one player, pruning the subscription if it's gone.
  async function sendTo(
    gameId: string,
    playerId: string,
    subscription: PushSubscription,
    payload: PushPayload,
  ): Promise<void> {
    const result = await sender.send(subscription, payload);
    if (result.gone) store.removeIfEndpoint(gameId, playerId, subscription.endpoint);
  }

  // Fan a payload out to a chosen subset of a game's subscribers, concurrently.
  // `allSettled` (not `all`) so one recipient's failure neither aborts the fan-out
  // nor collapses the batch into a single opaque rejection — each failure is
  // logged against the player it belongs to, and every other send still runs.
  async function fanOut(
    gameId: string,
    payload: PushPayload,
    include: (playerId: string) => boolean,
  ): Promise<void> {
    const recipients = store.forGame(gameId).filter((s) => include(s.playerId));
    const results = await Promise.allSettled(
      recipients.map((s) => sendTo(gameId, s.playerId, s.subscription, payload)),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(`push to ${recipients[i]?.playerId} failed:`, reason);
      }
    }
  }

  return {
    async notifyCaught(gameId, event) {
      const subscription = store.get(gameId, event.targetId);
      if (!subscription) return;
      await sendTo(gameId, event.targetId, subscription, caughtPayload(gameId));
    },

    async notifyReveal(gameId) {
      await fanOut(gameId, revealPayload(gameId), (playerId) => roleOf(gameId, playerId) === 'hunter');
    },

    async notifyGameOver(summary) {
      await fanOut(summary.gameId, gameOverPayload(summary), () => true);
    },
  };
}
