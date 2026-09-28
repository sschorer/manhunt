/**
 * The WebSocket message contract — the single source of truth for every message
 * that crosses a Game's socket between the client and the authoritative Game,
 * and the schema of its payload. Inbound payloads are validated by
 * `shared/validators.ts` before the Game acts on them. Creating and joining a
 * Game are HTTP routes, not messages (see `server/worker.ts`).
 *
 * Two directions:
 *
 * - **Inbound** (`INBOUND_EVENTS`) — sent by a client, handled by the Game.
 *   Every inbound payload is untrusted.
 * - **Outbound** (`OUTBOUND_EVENTS`) — sent by the Game to the Seats it concerns.
 *
 * See `docs/arc42.md` §6 (runtime view) and the README "WebSocket message
 * contract" section. Domain terms follow `server/CONTEXT.md`.
 */

/** Inbound events (client → server). */
export const INBOUND_EVENTS = {
  setRole: 'set_role',
  setBoundary: 'set_boundary',
  setReady: 'set_ready',
  startGame: 'start_game',
  leaveGame: 'leave_game',
  positionUpdate: 'position_update',
  claimCatch: 'claim_catch',
  pushSubscribe: 'push_subscribe',
  pushUnsubscribe: 'push_unsubscribe',
} as const;

/** Outbound events (server → client) sent to the Seats they concern. */
export const OUTBOUND_EVENTS = {
  gameState: 'game_state',
  catchConfirmed: 'catch_confirmed',
  lobbyUpdate: 'lobby_update',
  boundaryWarning: 'boundary_warning',
  playerEliminated: 'player_eliminated',
  gameOver: 'game_over',
} as const;

export type InboundEventName = (typeof INBOUND_EVENTS)[keyof typeof INBOUND_EVENTS];
export type OutboundEventName = (typeof OUTBOUND_EVENTS)[keyof typeof OUTBOUND_EVENTS];

// --- Shared shapes ---------------------------------------------------------

/** Which side a player is on. */
export type Role = 'hunter' | 'hider';

/** Lifecycle of a game. */
export type GameStatus = 'lobby' | 'active' | 'ended';

/** Characters a Join code is drawn from (no easily-confused `I`, `O`, `0`, `1`). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Number of characters in a Join code. */
export const ROOM_CODE_LENGTH = 4;

/** A participant in a lobby. */
export interface Player {
  id: string;
  name: string;
  role: Role;
  /** Whether the player has readied up. */
  ready: boolean;
  /** The host created the room and is the only one who may start it. */
  isHost: boolean;
  /**
   * True once the player was eliminated and is out of play — today only for
   * staying outside the Boundary (see {@link PlayerEliminatedEvent}). Absent
   * while they are still playing. Part of the roster so a client that reloads or
   * reconnects still learns who is out.
   */
  eliminated?: boolean;
}

/**
 * A circular play area: a centre point and a radius in metres. The same shape
 * the client draws as its boundary overlay and the server geofences against.
 */
export interface BoundaryCircle {
  center: { lat: number; lng: number };
  radiusM: number;
}

/** The timing rules a Game runs with, so clients can show matching countdowns. */
export interface GameRules {
  /** Milliseconds between Ping reveals. */
  pingIntervalMs: number;
  /** How long a Game runs, in milliseconds. */
  gameDurationMs: number;
}

/** A room and everyone in it. */
export interface Game {
  id: string;
  /** Short human-typed join code (see {@link ROOM_CODE_ALPHABET}). */
  roomCode: string;
  status: GameStatus;
  players: Player[];
  /**
   * The circular play area the rules engine geofences against (BACKLOG.md #11).
   * Optional: a game with no boundary is simply unenforced.
   */
  boundary?: BoundaryCircle;
  createdAt: string;
  startedAt?: string;
  /** Sent by the Worker backend; without it the client falls back to its defaults. */
  rules?: GameRules;
}

/** A player's latest reported position. */
export interface Position {
  lat: number;
  lng: number;
  /** When the server recorded it (ISO-8601). */
  recordedAt: string;
  /**
   * The owner's role, stored alongside the position so the server can apply
   * visibility filtering (hunters don't see hiders) without a separate roster
   * lookup. Omitted for the raw coordinate a client receives.
   */
  role?: Role;
}

/** Latest position per player id, for one game. */
export type PositionsByPlayer = Record<string, Position>;

/** Which side won the match. */
export type Winner = 'hunters' | 'hiders';

/**
 * Why a match ended. `all_caught` — the last hider was caught (hunters win);
 * `timer` — the duration elapsed with a hider still free (hiders win).
 */
export type EndReason = 'all_caught' | 'timer';

/** A catch that happened during the match: a hunter caught a hider at a moment. */
export interface CatchRecord {
  hunterId: string;
  targetId: string;
  /** When the server confirmed the catch (ISO-8601). */
  at: string;
}

/** One hider's line on the end screen: whether they were caught and how long they lasted. */
export interface HiderOutcome {
  playerId: string;
  name: string;
  /** True if this hider was caught before the game ended; false if they survived. */
  caught: boolean;
  /** How long the hider lasted, in milliseconds — until caught, or until the game ended. */
  survivalMs: number;
  /** When this hider was caught (ISO-8601). Absent when they survived to the end. */
  caughtAt?: string;
}

/**
 * The end-of-game summary (BACKLOG.md #15, #19): the winner and why, the match's
 * span, every catch, and each original hider's survival time (longest-lasting
 * first).
 */
export interface GameSummary {
  gameId: string;
  winner: Winner;
  reason: EndReason;
  /** When the match started (ISO-8601). */
  startedAt: string;
  /** When the match ended (ISO-8601). */
  endedAt: string;
  /** How long the match ran, in milliseconds. */
  durationMs: number;
  /** Every catch that happened, in the order they were confirmed. */
  catches: CatchRecord[];
  /** Each original hider's outcome, sorted by survival time descending. */
  hiders: HiderOutcome[];
}

/**
 * A browser push subscription, the shape `PushSubscription.toJSON()` produces —
 * an endpoint at the push service and the ECDH/auth keys used to encrypt the
 * payload.
 */
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// --- Inbound payloads (client → server) ------------------------------------

/** `set_role` — switch the caller's own side in the lobby. */
export interface SetRolePayload {
  role: Role;
}

/** `set_ready` — ready up (or stand down) in the lobby. */
export interface SetReadyPayload {
  ready: boolean;
}

/**
 * `position_update` — one tick of a client's reported location. Advisory input:
 * the Game assigns the authoritative `recordedAt` timestamp, then applies its
 * speed plausibility guard, the Boundary geofence and the per-role filter that
 * decides who sees the fix (`server/game/game.ts`, BACKLOG.md #11/#14).
 * Coordinates are validated to the WGS84 ranges here; the Boundary is a
 * per-game rule the Game checks itself (#11).
 */
export interface PositionUpdatePayload {
  gameId: string;
  playerId: string;
  lat: number;
  lng: number;
}

/**
 * `claim_catch` — a hunter claims to have caught a hider (or scanned their
 * code). The server verifies the claim; the authoritative catch-radius check
 * and hider→hunter role switch are the rules engine's job (#12), which gates
 * the resulting {@link CatchConfirmedEvent}.
 */
export interface ClaimCatchPayload {
  gameId: string;
  hunterId: string;
  targetId: string;
}

/**
 * `set_boundary` — the host defines (or replaces) the game's circular play area,
 * the geofence the rules engine enforces (BACKLOG.md #11). Identity is the
 * socket's lobby membership, so the payload carries only the boundary shape; the
 * server checks the caller is the host.
 */
export interface SetBoundaryPayload {
  boundary: BoundaryCircle;
}

/**
 * `push_subscribe` — the player opts in to Web Push (BACKLOG.md #23). The payload
 * is the browser's `PushSubscription.toJSON()`: the push-service endpoint and the
 * encryption keys the server needs to deliver a payload. Identity is the socket's
 * lobby membership, so the server files it against the caller's game and player;
 * the complementary `push_unsubscribe` carries no payload and drops it.
 */
export type PushSubscribePayload = PushSubscription;

// --- Outbound payloads (server → client) -----------------------------------

/** `game_state` — a game's latest per-player positions, fanned out to its room. */
export interface GameStateEvent {
  gameId: string;
  positions: PositionsByPlayer;
  /**
   * True when this broadcast is a scheduled ping reveal (BACKLOG.md #13): hider
   * positions are disclosed to hunters for this tick. Absent on an ordinary
   * per-role-filtered broadcast. Clients can use it to surface the reveal (e.g. a
   * "you've been pinged" cue for hiders, a fix flash for hunters).
   */
  reveal?: boolean;
}

/** `catch_confirmed` — the server accepted a catch; broadcast to the game's room. */
export interface CatchConfirmedEvent {
  gameId: string;
  hunterId: string;
  targetId: string;
  /** When the server confirmed the catch (ISO-8601). */
  at: string;
}

/** `lobby_update` — the full roster/status after any lobby change. */
export interface LobbyUpdateEvent {
  game: Game;
}

/**
 * `boundary_warning` — the server saw this player outside the play area and is
 * warning them before elimination (BACKLOG.md #11). Sent to the offending player;
 * `warningsRemaining` reaches 0 on the last warning, after which a continued exit
 * eliminates.
 */
export interface BoundaryWarningEvent {
  gameId: string;
  playerId: string;
  /** Warnings issued on this excursion so far. */
  warnings: number;
  /** Warnings left before elimination (0 means the next exit eliminates). */
  warningsRemaining: number;
  /** How far outside the boundary the player is, in metres. */
  metersOutside: number;
  /** When the server issued the warning (ISO-8601). */
  at: string;
}

/**
 * `player_eliminated` — the server removed a player from play. Broadcast to the
 * whole room so everyone (and the win-condition check, BACKLOG.md #15) learns of
 * it. `reason` is stable for future causes (boundary today; forfeit/timeout later).
 */
export interface PlayerEliminatedEvent {
  gameId: string;
  playerId: string;
  reason: 'boundary';
  /** When the server eliminated the player (ISO-8601). */
  at: string;
}

/**
 * `game_over` — the server detected a win condition and ended the match
 * (BACKLOG.md #15). Broadcast to the whole room so every client can switch to the
 * end screen.
 */
export interface GameOverEvent {
  gameId: string;
  summary: GameSummary;
}

// --- Replies ---------------------------------------------------------------

/** A rejected request, with a human-readable `error` and an optional stable `code`. */
export interface ErrorAck {
  ok: false;
  error: string;
  code?: string;
}

/** Reply to lobby actions: the current game on success, an error otherwise. */
export type LobbyAck = { ok: true; game: Game; playerId: string } | ErrorAck;

/** Reply to `claim_catch`: the confirmed catch on success, an error otherwise. */
export type CatchAck = { ok: true; catch: CatchConfirmedEvent } | ErrorAck;

/** Reply to actions that only report success (`set_ready`, `push_subscribe`, …). */
export type OkAck = { ok: true } | ErrorAck;

// --- Event maps ------------------------------------------------------------

/** Payload type of every inbound event, keyed by wire name. */
export interface InboundEventMap {
  set_role: SetRolePayload;
  set_boundary: SetBoundaryPayload;
  set_ready: SetReadyPayload;
  start_game: Record<string, never>;
  leave_game: undefined;
  position_update: PositionUpdatePayload;
  claim_catch: ClaimCatchPayload;
  push_subscribe: PushSubscribePayload;
  push_unsubscribe: undefined;
}

/** Payload type of every outbound event, keyed by wire name. */
export interface OutboundEventMap {
  game_state: GameStateEvent;
  catch_confirmed: CatchConfirmedEvent;
  lobby_update: LobbyUpdateEvent;
  boundary_warning: BoundaryWarningEvent;
  player_eliminated: PlayerEliminatedEvent;
  game_over: GameOverEvent;
}
