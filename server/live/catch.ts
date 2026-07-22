/**
 * Catch detection — the rules-engine catch-radius check (BACKLOG.md #12,
 * docs/arc42.md §6.2 "Catch" and the §8 glossary "Catch radius"). When a hunter
 * emits `claim_catch`, the server decides authoritatively — from the latest
 * server-side positions, never from the client — whether the hunter is close
 * enough to the claimed hider to catch them. A confirmed catch flips the caught
 * hider to a hunter; the transport layer performs the roster mutation and
 * broadcasts `catch_confirmed` (see `server/app.ts`). Like every game-affecting
 * decision this is computed server-side (docs/arc42.md quality goal #1
 * "Fairness / authority"): a hunter who spoofs GPS to claim an out-of-range
 * catch is rejected with no state change (docs/arc42.md §10 risk table).
 *
 * The distance maths is pure and reuses the tick engine's great-circle helper,
 * so a claim is one cheap check over the snapshot the tick engine already
 * maintains.
 */
import { haversineMeters } from './tick.ts';
import type { PlayerRole, Position } from './positions.ts';

/**
 * Default catch radius in metres: how close a hunter must be to a hider for a
 * claim to succeed. A few paces — tight enough that a catch means real physical
 * proximity, loose enough to absorb ordinary GPS jitter. Tunable per game once
 * game settings land (BACKLOG.md #27).
 */
export const DEFAULT_CATCH_RADIUS_M = 15;

/** Why the rules engine rejected a catch claim. Stable codes for acks/logging. */
export type CatchRejectReason =
  | 'not_hunter' // the claimant isn't a hunter
  | 'not_hider' // the target isn't a hider (already a hunter / already caught)
  | 'no_position' // no reported fix for the hunter or the target to measure against
  | 'out_of_range'; // both known, but too far apart

/** A catch the rules engine accepted: the measured separation at claim time. */
export interface CatchAccepted {
  ok: true;
  /** Great-circle distance between hunter and target when the claim was made, in metres. */
  distanceM: number;
}

/** A catch the rules engine rejected, with a stable reason. */
export interface CatchRejected {
  ok: false;
  reason: CatchRejectReason;
  /** The measured separation, present only when both positions were known (`out_of_range`). */
  distanceM?: number;
}

export type CatchDecision = CatchAccepted | CatchRejected;

/**
 * Everything the catch check needs, resolved server-side by the caller: the two
 * players' authoritative roles (from the lobby roster) and their latest fixes
 * (from the tick engine's read model), plus the game's catch radius.
 */
export interface CatchClaim {
  /** The claimant's role — must be `hunter`. */
  hunterRole: PlayerRole | undefined;
  /** The target's role — must be `hider`. */
  targetRole: PlayerRole | undefined;
  /** The hunter's latest server-side position, if any. */
  hunterPosition: Position | undefined;
  /** The target's latest server-side position, if any. */
  targetPosition: Position | undefined;
  /** The catch radius to test against, in metres. */
  radiusM: number;
}

/**
 * Decide a catch claim authoritatively. A claim succeeds only when the claimant
 * is a hunter, the target is a still-uncaught hider, both have a reported fix,
 * and their great-circle separation is within `radiusM`. Positions are taken as
 * given — rejecting a fix as too old to trust is input-layer anti-cheat, tracked
 * separately (BACKLOG.md #26). Pure and stateless: the caller supplies the
 * resolved roles and positions.
 */
export function evaluateCatch({
  hunterRole,
  targetRole,
  hunterPosition,
  targetPosition,
  radiusM,
}: CatchClaim): CatchDecision {
  if (hunterRole !== 'hunter') return { ok: false, reason: 'not_hunter' };
  if (targetRole !== 'hider') return { ok: false, reason: 'not_hider' };
  if (!hunterPosition || !targetPosition) return { ok: false, reason: 'no_position' };
  const distanceM = haversineMeters(hunterPosition, targetPosition);
  if (distanceM > radiusM) return { ok: false, reason: 'out_of_range', distanceM };
  return { ok: true, distanceM };
}
