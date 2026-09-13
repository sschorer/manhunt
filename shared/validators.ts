/**
 * Validators for untrusted inbound payloads (`shared/messages.ts`). A validator
 * returns the normalized value or a typed {@link Invalid} error; the server runs
 * one on every payload before it acts on it. Lobby payloads (`create_game`,
 * `join_game`, …) are validated by the lobby manager (`server/lobby/rooms.ts`).
 */
import { isPrivateIp } from './ip.ts';
import type {
  ClaimCatchPayload,
  JoinPayload,
  PositionUpdatePayload,
  PushSubscribePayload,
  ResumePayload,
  SetBoundaryPayload,
} from './messages.ts';

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

/**
 * Validate a `resume` payload: the game and player identity to reclaim, plus the
 * server-issued `resumeToken` that authenticates the claim (see
 * {@link ResumePayload}). Shape only — the handler verifies the token against the
 * one it minted for this player.
 */
export function validateResume(payload: unknown): Validation<ResumePayload> {
  const body = asRecord(payload);
  if (!body) return invalid('invalid_payload', 'Expected an object');
  if (!isNonEmptyString(body.gameId)) {
    return invalid('game_id_required', 'gameId is required');
  }
  if (!isNonEmptyString(body.playerId)) {
    return invalid('player_id_required', 'playerId is required');
  }
  if (!isNonEmptyString(body.resumeToken)) {
    return invalid('resume_token_required', 'resumeToken is required');
  }
  return valid({ gameId: body.gameId, playerId: body.playerId, resumeToken: body.resumeToken });
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
 * Whether an endpoint host is one we must never dial: `localhost`, or a literal
 * IP in private/reserved space (see {@link isPrivateIp}, which also unwraps
 * IPv4-mapped/NAT64 IPv6 literals). Real push-service endpoints (FCM, Mozilla,
 * Apple, WNS) are public hostnames, never these; a subscription pointing here is
 * a client trying to steer the server's outbound request at its own network
 * (SSRF), so it's rejected. A hostname that only *resolves* to a private address
 * is caught later, at send time, by the guarded HTTPS agent (`server/push/ssrf.ts`).
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isPrivateIp(host);
}

/**
 * Whether a subscription endpoint is a public HTTPS URL safe to hand to the push
 * sender. The server later makes an outbound request to it, so an unvalidated
 * value is an SSRF vector: require a well-formed `https:` URL and reject
 * loopback/private/reserved hosts.
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
 * (see {@link isSafePushEndpoint}) before it can be stored. The normalized value
 * keeps only those recognized fields, so a client can't smuggle extra properties
 * through to the sender.
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
