/**
 * The WebSocket message contract — the single source of truth for every event
 * that crosses the socket between the client and the authoritative server, the
 * schema of its payload, and (for inbound, client→server events) a validator
 * the server runs on every payload before it acts on it.
 *
 * Two directions:
 *
 * - **Inbound** (`INBOUND_EVENTS`) — emitted by a client, handled by the server.
 *   Every inbound payload is untrusted and is validated here before use; a
 *   validator returns the normalized value or a typed {@link Invalid} error.
 * - **Outbound** (`OUTBOUND_EVENTS`) — emitted by the server to a game's room.
 *   These are described by their payload types so both sides share one shape.
 *
 * See `docs/arc42.md` §6 (runtime view) and the README "WebSocket message
 * contract" section. Lobby events (`create_game`, `join_game`, …) round out the
 * inbound set; their payloads are validated by the lobby manager
 * (`server/lobby/rooms.ts`) and are named here so the contract lists every
 * event in one place.
 */
import type { PositionsByPlayer } from '../live/index.ts';
import type { Game } from '../lobby/rooms.ts';

/** Inbound events (client → server) that carry a validated game-loop payload. */
export const INBOUND_EVENTS = {
  join: 'join',
  positionUpdate: 'position_update',
  claimCatch: 'claim_catch',
} as const;

/** Outbound events (server → client) broadcast to a game's room. */
export const OUTBOUND_EVENTS = {
  gameState: 'game_state',
  catchConfirmed: 'catch_confirmed',
  lobbyUpdate: 'lobby_update',
} as const;

// --- Inbound payloads (client → server) ------------------------------------

/** `join` — subscribe this socket to a game's broadcasts. */
export interface JoinPayload {
  gameId: string;
}

/**
 * `position_update` — one tick of a client's reported location. Advisory input:
 * the server assigns the authoritative `recordedAt` timestamp, the tick engine
 * (`server/live/tick.ts`) applies its plausibility guard, and the rules engine
 * (boundary/catch/role filtering) is layered on separately (BACKLOG.md #11/#14).
 * Coordinates are validated to the WGS84 ranges here; the game's play-area
 * geofence is a separate, per-game rule (#11).
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

// --- Outbound payloads (server → client) -----------------------------------

/** `game_state` — a game's latest per-player positions, fanned out to its room. */
export interface GameStateEvent {
  gameId: string;
  positions: PositionsByPlayer;
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

// --- Validation ------------------------------------------------------------

/** WGS84 coordinate bounds an inbound position must fall within. */
export const LAT_RANGE = { min: -90, max: 90 } as const;
export const LNG_RANGE = { min: -180, max: 180 } as const;

/** A payload that passed validation, carrying the normalized value. */
export interface Valid<T> {
  ok: true;
  value: T;
}

/** A rejected payload, with a stable `code` and a human-readable `error`. */
export interface Invalid {
  ok: false;
  code: string;
  error: string;
}

/** The result of validating an untrusted inbound payload. */
export type Validation<T> = Valid<T> | Invalid;

function valid<T>(value: T): Valid<T> {
  return { ok: true, value };
}

function invalid(code: string, error: string): Invalid {
  return { ok: false, code, error };
}

function asRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validate a `join` payload. */
export function validateJoin(payload: unknown): Validation<JoinPayload> {
  const body = asRecord(payload);
  if (!body) return invalid('invalid_payload', 'Expected an object');
  if (!isNonEmptyString(body.gameId)) {
    return invalid('game_id_required', 'gameId is required');
  }
  return valid({ gameId: body.gameId });
}

/** Validate a `position_update` payload, including WGS84 coordinate bounds. */
export function validatePositionUpdate(
  payload: unknown,
): Validation<PositionUpdatePayload> {
  const body = asRecord(payload);
  if (!body) return invalid('invalid_payload', 'Expected an object');
  if (!isNonEmptyString(body.gameId)) {
    return invalid('game_id_required', 'gameId is required');
  }
  if (!isNonEmptyString(body.playerId)) {
    return invalid('player_id_required', 'playerId is required');
  }
  const { lat, lng } = body;
  if (
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    lat < LAT_RANGE.min ||
    lat > LAT_RANGE.max ||
    typeof lng !== 'number' ||
    !Number.isFinite(lng) ||
    lng < LNG_RANGE.min ||
    lng > LNG_RANGE.max
  ) {
    return invalid('invalid_coordinates', 'lat/lng must be within valid WGS84 bounds');
  }
  return valid({ gameId: body.gameId, playerId: body.playerId, lat, lng });
}

/** Validate a `claim_catch` payload. A hunter cannot catch themselves. */
export function validateClaimCatch(payload: unknown): Validation<ClaimCatchPayload> {
  const body = asRecord(payload);
  if (!body) return invalid('invalid_payload', 'Expected an object');
  if (!isNonEmptyString(body.gameId)) {
    return invalid('game_id_required', 'gameId is required');
  }
  if (!isNonEmptyString(body.hunterId)) {
    return invalid('hunter_id_required', 'hunterId is required');
  }
  if (!isNonEmptyString(body.targetId)) {
    return invalid('target_id_required', 'targetId is required');
  }
  if (body.hunterId === body.targetId) {
    return invalid('self_catch', 'A hunter cannot catch themselves');
  }
  return valid({ gameId: body.gameId, hunterId: body.hunterId, targetId: body.targetId });
}
