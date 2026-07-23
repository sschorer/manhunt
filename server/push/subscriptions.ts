/**
 * The push-subscription store (BACKLOG.md #23). When a player opts in to Web Push
 * the browser mints a {@link PushSubscription} — an endpoint URL at their push
 * service plus the keys the server needs to encrypt a payload for it — and the
 * server keeps it here, associated with the player's game so a game event can be
 * routed to the right people (a catch to the caught hider, a reveal to the
 * hunters, the game-over to everyone).
 *
 * Like the lobby and the live-position store, this is **ephemeral, in-process
 * hot state**: a subscription only matters for the life of the game it belongs
 * to. It is dropped when the player leaves, when the room empties, and (for a
 * subscription the push service reports gone) when a send fails with 404/410.
 * Durable storage in PostgreSQL is a later concern, out of scope for this
 * milestone — mirroring the lobby's own note.
 *
 * State is keyed by game, then by player, holding one subscription per player
 * (the latest opt-in wins), so a player who re-subscribes from a new device or
 * after clearing their old subscription simply replaces it.
 */

/**
 * A browser push subscription, the shape `PushSubscription.toJSON()` produces —
 * an endpoint at the push service and the ECDH/auth keys used to encrypt the
 * payload. Passed straight to the web-push sender; validated on the way in (see
 * `validatePushSubscription` in `server/protocol/messages.ts`) since it arrives
 * from an untrusted client.
 */
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** One stored subscription with the player it belongs to. */
export interface StoredSubscription {
  playerId: string;
  subscription: PushSubscription;
}

/** Per-game registry of the players who have opted in to Web Push. */
export interface SubscriptionStore {
  /**
   * Record (or replace) a player's subscription for a game. One per player — a
   * fresh opt-in supersedes the old one, so a client can safely re-subscribe.
   */
  add(gameId: string, playerId: string, subscription: PushSubscription): void;
  /** Drop a single player's subscription. A no-op if they had none. */
  remove(gameId: string, playerId: string): void;
  /**
   * Drop a player's subscription only if it matches `endpoint` — used to prune a
   * subscription the push service reported gone (404/410) without clobbering a
   * newer one the player may have registered since the send began.
   */
  removeIfEndpoint(gameId: string, playerId: string, endpoint: string): void;
  /** Forget every subscription for a game (the room emptied, the game ended). */
  removeGame(gameId: string): void;
  /** A player's current subscription, or `undefined` if they haven't opted in. */
  get(gameId: string, playerId: string): PushSubscription | undefined;
  /** Every opted-in player in a game. Empty for an unknown game. */
  forGame(gameId: string): StoredSubscription[];
}

/**
 * Build an in-memory subscription store. State is a map of game id to a map of
 * player id to subscription; {@link SubscriptionStore.remove}/`removeGame` keep
 * it from leaking entries once players or games are gone.
 */
export function createSubscriptionStore(): SubscriptionStore {
  const games = new Map<string, Map<string, PushSubscription>>();

  return {
    add(gameId, playerId, subscription) {
      let players = games.get(gameId);
      if (!players) {
        players = new Map();
        games.set(gameId, players);
      }
      players.set(playerId, subscription);
    },

    remove(gameId, playerId) {
      const players = games.get(gameId);
      if (!players) return;
      players.delete(playerId);
      if (players.size === 0) games.delete(gameId);
    },

    removeIfEndpoint(gameId, playerId, endpoint) {
      const players = games.get(gameId);
      const current = players?.get(playerId);
      if (!players || !current || current.endpoint !== endpoint) return;
      players.delete(playerId);
      if (players.size === 0) games.delete(gameId);
    },

    removeGame(gameId) {
      games.delete(gameId);
    },

    get(gameId, playerId) {
      return games.get(gameId)?.get(playerId);
    },

    forGame(gameId) {
      const players = games.get(gameId);
      if (!players) return [];
      return [...players.entries()].map(([playerId, subscription]) => ({
        playerId,
        subscription,
      }));
    },
  };
}
