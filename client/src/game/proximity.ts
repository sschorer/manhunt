/**
 * Proximity read-model for the in-game HUD: turning the raw positions the server
 * fans out into the "nearest opponent is 90 m to the northeast" cue each role
 * gets, plus the accumulated hider *sightings* a hunter map shows.
 *
 * A hunter only ever receives a hider's coordinates on a scheduled ping reveal
 * (the server withholds them otherwise, BACKLOG.md #14). So between reveals a
 * hunter has nothing live to point at — the map instead shows each hider's *last
 * known* position, ageing as a "last seen" ghost. {@link mergeSightings}
 * accumulates those last-known fixes across ticks; a hider's own view needs no
 * such memory because it can see the hunters live.
 *
 * All pure and side-effect free so the maths is unit-testable on its own.
 */
import { bearingDegrees, compassDirection, distanceMeters, type LngLat } from './geo.ts';
import type { LivePosition, LivePositions } from './useLivePositions.ts';

/**
 * How close an opponent must be, in metres, for the HUD to raise a proximity
 * alert. Loose enough to be a useful early warning at play-area scale, tight
 * enough that it means "act now", and the radius the alert ring around the
 * player draws.
 */
export const PROXIMITY_ALERT_M = 150;

/** Radius, in metres, of the "you could be seen from here" ring a hider is shown on a reveal. */
export const REVEAL_RADIUS_M = 200;

/** The nearest opponent to the player: who, how far, and in which direction. */
export interface Proximity {
  /** The opponent's player id. */
  id: string;
  /** Great-circle distance to them, in metres. */
  distanceM: number;
  /** Initial compass bearing to them, in degrees clockwise from north. */
  bearing: number;
  /** That bearing as a named compass point (e.g. `"northeast"`). */
  direction: string;
}

/**
 * The nearest of `others` to `self`, or `null` when the player has no fix yet or
 * there is no one to measure against. Distance and bearing are computed with the
 * same great-circle maths the server uses, so the readout tracks reality within
 * GPS jitter.
 */
export function nearest(self: LngLat | null, others: LivePositions): Proximity | null {
  if (!self) return null;
  let best: Proximity | null = null;
  for (const [id, pos] of Object.entries(others)) {
    const target = { lng: pos.lng, lat: pos.lat };
    const distanceM = distanceMeters(self, target);
    if (best && distanceM >= best.distanceM) continue;
    const bearing = bearingDegrees(self, target);
    best = { id, distanceM, bearing, direction: compassDirection(bearing) };
  }
  return best;
}

/** Accumulated last-known position per hider id — the hunter map's ghost markers. */
export type Sightings = Record<string, LivePosition>;

/**
 * Fold whichever hider positions are currently visible into the accumulated
 * sightings, keeping the newest fix per hider. `visible` is already role-filtered
 * by the caller to hiders only. Returns the previous object unchanged (same
 * reference) when nothing newer arrived, so a React state setter fed this can
 * bail out of a re-render.
 */
export function mergeSightings(prev: Sightings, visible: LivePositions): Sightings {
  let next: Sightings | null = null;
  for (const [id, pos] of Object.entries(visible)) {
    const existing = prev[id];
    if (existing && existing.recordedAt === pos.recordedAt) continue;
    next ??= { ...prev };
    next[id] = pos;
  }
  return next ?? prev;
}
