/**
 * What each pushed notification says, and how the push service should treat it.
 * Pure data, built by the game core alongside the messages of the same command
 * (`server/game/game.ts`) and handed to `server/push/send.ts` to deliver.
 *
 * Three moments are pushed, because each of them matters to a player whose phone
 * is in their pocket:
 *
 * - **caught** — the Hider who was just caught, who most wants to know the instant
 *   it happens.
 * - **reveal** — the Hunters, whose one periodic fix on the Hiders this is. The
 *   Hiders know they were revealed from the app itself.
 * - **game over** — everyone, with who won.
 *
 * The texts and the recipients are the ones the old server pushed; the core now
 * resolves the recipients from its own roster.
 */
import type { GameSummary, Winner } from '../../shared/index.ts';

/** An hour, in seconds: long enough that a phone which was off still gets it. */
const HOUR_S = 3600;

/**
 * How long a push service keeps a reveal, in seconds: the default Ping reveal
 * interval, after which the reveal is worthless. A Game on a shorter interval
 * relies on {@link PushNotification.topic} instead, which replaces the earlier
 * reveal rather than stacking a stale one behind it.
 */
const REVEAL_TTL_S = 180;

/**
 * The JSON payload the service worker receives (`client/public/push-sw.js`).
 * `tag` lets the browser coalesce repeats — a second reveal replaces the first
 * rather than stacking — and `data` carries context for the click handler.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Coalescing tag: a new notification with the same tag replaces the old one. */
  tag: string;
  data: {
    gameId: string;
    kind: 'caught' | 'reveal' | 'game_over';
    [key: string]: unknown;
  };
}

/** One notification, with the delivery options the push service reads. */
export interface PushNotification {
  payload: PushPayload;
  /** How long the push service may hold the notification for, in seconds. */
  ttl: number;
  /** `high` wakes the device right away; `normal` may be batched. */
  urgency: 'high' | 'normal' | 'low';
  /**
   * The push service replaces an undelivered notification carrying the same
   * topic, so a queue of stale ones never lands at once.
   */
  topic?: string;
}

/** The push the caught Hider receives. */
export function caughtNotification(gameId: string): PushNotification {
  return {
    payload: {
      title: "You've been caught!",
      body: "A hunter tagged you — you're on the hunt now.",
      tag: `manhunt:${gameId}:caught`,
      data: { gameId, kind: 'caught' },
    },
    ttl: HOUR_S,
    urgency: 'high',
  };
}

/** The push the Hunters receive on a Ping reveal. */
export function revealNotification(gameId: string): PushNotification {
  return {
    payload: {
      title: 'Hiders revealed',
      body: "A ping just exposed the hiders' positions — check the map.",
      tag: `manhunt:${gameId}:reveal`,
      data: { gameId, kind: 'reveal' },
    },
    ttl: REVEAL_TTL_S,
    urgency: 'normal',
    topic: `reveal-${gameId}`,
  };
}

/** How each side's win reads to a player on the game-over push. */
function winnerLine(winner: Winner): string {
  return winner === 'hunters'
    ? 'The hunters win — every hider was caught.'
    : 'The hiders win — they survived the clock.';
}

/** The push everyone in the Game receives when it ends. */
export function gameOverNotification(summary: GameSummary): PushNotification {
  return {
    payload: {
      title: 'Game over',
      body: winnerLine(summary.winner),
      tag: `manhunt:${summary.gameId}:game_over`,
      data: {
        gameId: summary.gameId,
        kind: 'game_over',
        winner: summary.winner,
        reason: summary.reason,
      },
    },
    ttl: HOUR_S,
    urgency: 'normal',
  };
}
