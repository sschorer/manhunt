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
import type { BoundaryCircle, GameSummary, PositionsByPlayer } from '../live/index.ts';
import type { Game } from '../lobby/rooms.ts';
import type { PushSubscription } from '../push/subscriptions.ts';

/** Inbound events (client → server) that carry a validated game-loop payload. */
export const INBOUND_EVENTS = {
  join: 'join',
  positionUpdate: 'position_update',
  claimCatch: 'claim_catch',
  setBoundary: 'set_boundary',
  pushSubscribe: 'push_subscribe',
  pushUnsubscribe: 'push_unsubscribe',
} as const;

/** Outbound events (server → client) broadcast to a game's room. */
export const OUTBOUND_EVENTS = {
  gameState: 'game_state',
  catchConfirmed: 'catch_confirmed',
  lobbyUpdate: 'lobby_update',
  boundaryWarning: 'boundary_warning',
  playerEliminated: 'player_eliminated',
  gameOver: 'game_over',
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
 * end screen. The {@link GameSummary} payload carries who won and why, the match's
 * span, every catch, and each hider's survival time (see `server/live/outcome.ts`).
 */
export interface GameOverEvent {
  gameId: string;
  summary: GameSummary;
}

// --- Validation ------------------------------------------------------------

/** WGS84 coordinate bounds an inbound position must fall within. */
export const LAT_RANGE = { min: -90, max: 90 } as const;
export const LNG_RANGE = { min: -180, max: 180 } as const;

/**
 * Accepted range for a play-area radius, in metres. A boundary must enclose real
 * ground (positive radius) yet stay sane — 100 km comfortably covers any playable
 * area while rejecting a nonsensical planet-sized "boundary".
 */
export const BOUNDARY_RADIUS_RANGE = { min: 1, max: 100_000 } as const;

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

/** Whether a value is a finite number within an inclusive `[min, max]` range. */
function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Validate a `set_boundary` payload: a circular play area with a WGS84 centre and
 * a radius within {@link BOUNDARY_RADIUS_RANGE}. The normalized value carries only
 * the recognized fields.
 */
export function validateSetBoundary(payload: unknown): Validation<SetBoundaryPayload> {
  const body = asRecord(payload);
  if (!body) return invalid('invalid_payload', 'Expected an object');
  const boundary = asRecord(body.boundary);
  if (!boundary) return invalid('boundary_required', 'boundary is required');
  const center = asRecord(boundary.center);
  if (
    !center ||
    !isNumberInRange(center.lat, LAT_RANGE.min, LAT_RANGE.max) ||
    !isNumberInRange(center.lng, LNG_RANGE.min, LNG_RANGE.max)
  ) {
    return invalid('invalid_center', 'boundary.center must be a valid WGS84 coordinate');
  }
  if (!isNumberInRange(boundary.radiusM, BOUNDARY_RADIUS_RANGE.min, BOUNDARY_RADIUS_RANGE.max)) {
    return invalid(
      'invalid_radius',
      `boundary.radiusM must be between ${BOUNDARY_RADIUS_RANGE.min} and ${BOUNDARY_RADIUS_RANGE.max} metres`,
    );
  }
  return valid({
    boundary: { center: { lat: center.lat, lng: center.lng }, radiusM: boundary.radiusM },
  });
}

/**
 * IPv4 literals a push endpoint must never resolve to — loopback, link-local,
 * and the RFC 1918 private ranges — plus `localhost`. Real push-service
 * endpoints (FCM, Mozilla, Apple, WNS) are public hostnames, never these; a
 * subscription pointing here is a client trying to steer the server's outbound
 * request at its own network (SSRF), so it's rejected.
 */
/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 literal (`::ffff:…`,
 * which the URL parser normalizes to `::ffff:HHHH:HHHH`) or a NAT64 literal
 * (`64:ff9b::…`), so the IPv4 blocklist below applies to it too. Returns the
 * dotted-quad string, or `undefined` for an IPv6 host with no embedded IPv4.
 * Without this, `[::ffff:169.254.169.254]` would slip past the IPv4 checks.
 */
function embeddedIpv4(host: string): string | undefined {
  const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(host);
  if (!mapped) return undefined;
  const tail = mapped[1] as string;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!hex) return undefined;
  const hi = Number.parseInt(hex[1] as string, 16);
  const lo = Number.parseInt(hex[2] as string, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // IPv6 loopback (::1), unique-local (fc00::/7 → fc/fd), link-local (fe80::/10).
  if (host === '::1' || /^f[cd][0-9a-f]*:/.test(host) || /^fe[89ab][0-9a-f]*:/.test(host)) {
    return true;
  }
  // Reduce an IPv4-mapped / NAT64 IPv6 literal to its embedded IPv4 so the same
  // blocklist covers e.g. `[::ffff:169.254.169.254]`; a plain IPv4 host is used
  // as-is.
  const v4host = embeddedIpv4(host) ?? host;
  // IPv4 loopback (127/8), private (10/8, 172.16/12, 192.168/16), link-local
  // (169.254/16), and the unspecified address.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Whether a subscription endpoint is a public HTTPS URL safe to hand to the push
 * sender. The endpoint is later fetched by `web-push` (see
 * `server/push/webPushSender.ts`), so an unvalidated value is an SSRF vector:
 * require a well-formed `https:` URL and reject loopback/private/reserved hosts.
 */
function isSafePushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !isBlockedHost(url.hostname);
}

/**
 * Validate a `push_subscribe` payload (BACKLOG.md #23): the browser subscription
 * object, which must carry a non-empty `endpoint` and the `p256dh`/`auth`
 * encryption keys. The `endpoint` is further checked to be a public HTTPS URL
 * (see {@link isSafePushEndpoint}) before it can be stored, since the server
 * later makes an outbound request to it. The normalized value keeps only those
 * recognized fields, so a client can't smuggle extra properties through to the
 * sender.
 */
export function validatePushSubscription(
  payload: unknown,
): Validation<PushSubscribePayload> {
  const body = asRecord(payload);
  if (!body) return invalid('invalid_payload', 'Expected an object');
  if (!isNonEmptyString(body.endpoint)) {
    return invalid('endpoint_required', 'endpoint is required');
  }
  if (!isSafePushEndpoint(body.endpoint)) {
    return invalid('invalid_endpoint', 'endpoint must be a public https URL');
  }
  const keys = asRecord(body.keys);
  if (!keys || !isNonEmptyString(keys.p256dh) || !isNonEmptyString(keys.auth)) {
    return invalid('keys_required', 'keys.p256dh and keys.auth are required');
  }
  return valid({ endpoint: body.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
}
