/**
 * The authoritative tick engine (see docs/arc42.md §5 "Tick engine" and §6.1
 * "Game tick"). One tick is a single `position_update`: the engine ingests a
 * player's reported position, validates it, applies a plausibility guard, and
 * writes the accepted position to the hot store. It also exposes the latest
 * position of every player in a game — the snapshot the rules engine (boundary,
 * catch-radius, ping, win checks — BACKLOG.md #11/#12/#13/#15) consumes.
 *
 * Payload shape and WGS84 coordinate bounds are validated one layer up, at the
 * transport edge (`server/protocol/messages.ts`), so the engine works with an
 * already-normalized, identity-bound input. What the engine adds is the
 * *stateful* validation the message validator can't do on a lone payload:
 * comparing a new fix against the player's previous one to reject an implausible
 * jump. A fuller input-layer anti-cheat pass (multi-sample smoothing, accuracy
 * weighting) is tracked separately — BACKLOG.md #26.
 */
import type { PlayerRole, Position, PositionsByPlayer, PositionStore } from './positions.ts';

/** Mean Earth radius, for great-circle distance between two fixes. */
export const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Maximum ground speed the engine treats as plausible between two consecutive
 * fixes, in metres per second. Set well above any real player (a sprint is
 * ~10 m/s, a car ~40, a fast train ~90) so honest movement — even in a vehicle —
 * is never rejected, while an instant hop across the map (GPS spoof / teleport)
 * is. The rules and settings work (BACKLOG.md #26/#27) may tune this per game.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 150;

/** Why the engine rejected a tick. Stable codes for logging and future acks. */
export type TickRejectReason = 'implausible_speed';

/** A tick the engine accepted: the stored fix plus the game's fresh snapshot. */
export interface TickAccepted {
  ok: true;
  /** The position the engine wrote for this player. */
  position: Position;
  /** Every player's latest position after this write — the rules-engine input. */
  positions: PositionsByPlayer;
}

/** A tick the engine dropped without writing, with a stable reason code. */
export interface TickRejected {
  ok: false;
  reason: TickRejectReason;
}

export type TickResult = TickAccepted | TickRejected;

/**
 * One tick's input: a player's reported coordinates, already validated and bound
 * to the socket's authoritative lobby identity by the caller. The engine never
 * trusts a client-supplied timestamp — it stamps `at` (defaulting to now) as the
 * authoritative record time.
 */
export interface TickInput {
  gameId: string;
  playerId: string;
  /** The player's role, stored alongside the fix for per-role fan-out filtering. */
  role?: PlayerRole;
  lat: number;
  lng: number;
  /** Authoritative server time for this tick. Defaults to the current time. */
  at?: Date;
}

/** Tunables for {@link createTickEngine}. */
export interface TickEngineOptions {
  /** Reject a fix implying a ground speed above this (m/s). */
  maxSpeedMps?: number;
  /**
   * Clock used to stamp a tick's authoritative record time when the input
   * doesn't carry an explicit `at`. Defaults to the system clock; injected in
   * tests for a deterministic, monotonic sequence of record times.
   */
  now?: () => Date;
}

/** The authoritative ingest pipeline plus the rules engine's read model. */
export interface TickEngine {
  /**
   * Ingest one tick: validate against the player's previous fix, and on success
   * write it and return the game's fresh position snapshot. Rejections do not
   * mutate the store.
   */
  ingest(input: TickInput): Promise<TickResult>;
  /**
   * The latest position of every player in a game — the read model the rules
   * engine runs its boundary/catch/ping/win checks against.
   */
  latest(gameId: string): Promise<PositionsByPlayer>;
}

/** Convert degrees to radians. */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle (haversine) distance between two lat/lng points, in metres. Exact
 * enough at the scale of a play area, and cheap enough to run on every tick.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Decide whether moving from `prev` to `next` is physically plausible. Uses the
 * elapsed time between the two authoritative record stamps; only rejects when we
 * can measure a positive interval AND the implied speed exceeds `maxSpeedMps`. A
 * zero/negative interval (two fixes within the same millisecond, or a clock
 * quirk) can't yield a meaningful speed, so it's allowed through rather than
 * treated as an infinite-speed teleport.
 */
function isImplausibleJump(prev: Position, next: Position, maxSpeedMps: number): boolean {
  const elapsedMs = Date.parse(next.recordedAt) - Date.parse(prev.recordedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return false;
  const distanceM = haversineMeters(prev, next);
  return distanceM / (elapsedMs / 1000) > maxSpeedMps;
}

/**
 * Build a tick engine over a {@link PositionStore}. Ingest reads the game's
 * current snapshot once (to find the player's previous fix for the plausibility
 * check), writes on acceptance, and returns the snapshot updated in place — so a
 * normal tick costs one read and one write, and the caller gets the fresh state
 * to fan out without a second read.
 */
export function createTickEngine(
  store: PositionStore,
  { maxSpeedMps = MAX_PLAUSIBLE_SPEED_MPS, now = () => new Date() }: TickEngineOptions = {},
): TickEngine {
  // A tick's read-check-write must be atomic per player. The socket handler runs
  // ticks concurrently (Socket.IO doesn't await one before the next), so two
  // fixes for the same player arriving close together could otherwise both read
  // the same `previous`, both pass the plausibility check, and both write —
  // silently defeating the anti-teleport guard. Chaining a player's ticks makes
  // each one observe the prior one's write before its own check. Different
  // players stay fully concurrent, and a key is dropped once its chain drains so
  // the map stays bounded to active players. This closes the race within one
  // instance; a multi-instance deployment sharing a store needs a store-side
  // atomic check-and-set (a follow-up alongside the fuller anti-cheat, #26).
  const chains = new Map<string, Promise<unknown>>();

  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    // Run after the player's previous tick settles (resolve or reject — a failed
    // tick must not wedge the next one). Return the real result to the caller,
    // but chain the next tick off a non-rejecting continuation.
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return run;
  }

  return {
    ingest({ gameId, playerId, role, lat, lng, at }) {
      return serialize(`${gameId}:${playerId}`, async () => {
        const position: Position = {
          lat,
          lng,
          recordedAt: (at ?? now()).toISOString(),
          ...(role ? { role } : {}),
        };
        const positions = await store.readPositions(gameId);
        const previous = positions[playerId];
        if (previous && isImplausibleJump(previous, position, maxSpeedMps)) {
          return { ok: false, reason: 'implausible_speed' } as TickResult;
        }
        await store.writePosition(gameId, playerId, position);
        positions[playerId] = position;
        return { ok: true, position, positions } as TickResult;
      });
    },

    latest(gameId) {
      return store.readPositions(gameId);
    },
  };
}
