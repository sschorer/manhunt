/**
 * Boundary enforcement — the rules-engine geofence (BACKLOG.md #11, docs/arc42.md
 * §5 "Rules engine" and the §8 glossary "Boundary"). A game may define a circular
 * play area; every accepted position tick is checked against it, and a player who
 * strays outside is warned, then eliminated once the warnings run out. Like every
 * game-affecting decision, this is computed server-side from reported positions
 * and never trusted from the client (docs/arc42.md quality goal #1 "Fairness /
 * authority").
 *
 * The geofence maths is pure and reuses the tick engine's great-circle helper;
 * the warn→eliminate policy is a small per-player state machine so the transport
 * layer only has to react to the transitions this reports, not re-derive them.
 */
import { haversineMeters } from './tick.ts';

/**
 * A circular play area: a centre point and a radius in metres. This is the same
 * shape the client draws as its boundary overlay (`client/src/game/geo.ts`) and
 * the `games.boundary` column stores (see `db/schema.sql`), so one definition
 * describes the play area everywhere.
 */
export interface BoundaryCircle {
  center: { lat: number; lng: number };
  radiusM: number;
}

/**
 * Default number of warnings a player gets while outside the boundary before
 * being eliminated: one warning, then elimination on continued exit — the literal
 * "warns, then eliminates" of the issue's acceptance. Tunable per game once game
 * settings land (BACKLOG.md #27).
 */
export const DEFAULT_BOUNDARY_WARNINGS = 1;

/**
 * How far a position sits outside a boundary, in metres. `0` when the point is
 * inside or exactly on the radius. Pure — this is the geofence test itself.
 */
export function metersOutside(
  boundary: BoundaryCircle,
  pos: { lat: number; lng: number },
): number {
  return Math.max(0, haversineMeters(boundary.center, pos) - boundary.radiusM);
}

/** Whether a position is inside (or exactly on the edge of) a boundary. */
export function isInsideBoundary(
  boundary: BoundaryCircle,
  pos: { lat: number; lng: number },
): boolean {
  return metersOutside(boundary, pos) === 0;
}

/** What the monitor decided for one player on one tick against the boundary. */
export type BoundaryStatus = 'inside' | 'warned' | 'eliminated';

/** The monitor's verdict for a single evaluated tick. */
export interface BoundaryVerdict {
  status: BoundaryStatus;
  /**
   * True only on the tick that changes a player's state — the edge the transport
   * layer emits on: a fresh warning, the elimination, or a return inside after an
   * excursion. Steady state (still comfortably inside, or already eliminated)
   * reports `false` so nothing is re-emitted every tick.
   */
  changed: boolean;
  /** Warnings issued on the current excursion so far (`0` while inside). */
  warnings: number;
  /** Warnings left before elimination (`0` once eliminated). */
  warningsRemaining: number;
  /** How far outside the boundary this fix sits, in metres (`0` while inside). */
  metersOutside: number;
}

/** Tunables for {@link createBoundaryMonitor}. */
export interface BoundaryMonitorOptions {
  /**
   * Warnings a player receives while outside before being eliminated. `0`
   * eliminates on the first exit with no grace. Defaults to
   * {@link DEFAULT_BOUNDARY_WARNINGS}.
   */
  warningsBeforeElimination?: number;
}

/** Per-player geofence state machine over a game's play area. */
export interface BoundaryMonitor {
  /**
   * Evaluate one player's fix against a boundary, advancing their warn/eliminate
   * state and returning the verdict. Idempotent once a player is eliminated: they
   * stay out and further ticks report `changed: false`.
   */
  evaluate(input: {
    gameId: string;
    playerId: string;
    position: { lat: number; lng: number };
    boundary: BoundaryCircle;
  }): BoundaryVerdict;
  /**
   * Forget tracked state. With a `playerId`, drops just that player's entry —
   * called when a single player leaves a still-running game so their warn/
   * eliminate state doesn't linger. Without one, drops the whole game (teardown).
   */
  forget(gameId: string, playerId?: string): void;
}

/** A player's tracked boundary state within one game. */
interface PlayerState {
  /** Warnings issued on the current excursion (reset to 0 on re-entry). */
  warnings: number;
  /** Terminal: once eliminated for leaving, a player stays eliminated. */
  eliminated: boolean;
}

/**
 * Build a stateful boundary monitor. State is keyed per `gameId:playerId` and
 * bounded to players who have actually strayed (a player who never leaves the
 * area is never tracked); {@link BoundaryMonitor.forget} drops a whole game.
 */
export function createBoundaryMonitor({
  warningsBeforeElimination = DEFAULT_BOUNDARY_WARNINGS,
}: BoundaryMonitorOptions = {}): BoundaryMonitor {
  // Guard against a negative config making `warningsRemaining` nonsensical.
  const maxWarnings = Math.max(0, Math.trunc(warningsBeforeElimination));
  const states = new Map<string, PlayerState>();

  return {
    evaluate({ gameId, playerId, position, boundary }) {
      const key = `${gameId}:${playerId}`;
      const outside = metersOutside(boundary, position);
      const state = states.get(key);

      // Already eliminated: terminal, idempotent — report it without a new edge.
      if (state?.eliminated) {
        return {
          status: 'eliminated',
          changed: false,
          warnings: state.warnings,
          warningsRemaining: 0,
          metersOutside: outside,
        };
      }

      // Inside the play area: clear any accrued warnings. `changed` is true only
      // when this fix actually ends an excursion (the player had warnings).
      if (outside === 0) {
        const returned = (state?.warnings ?? 0) > 0;
        if (state) states.delete(key);
        return {
          status: 'inside',
          changed: returned,
          warnings: 0,
          warningsRemaining: maxWarnings,
          metersOutside: 0,
        };
      }

      // Outside and not yet eliminated: count this exit.
      const warnings = (state?.warnings ?? 0) + 1;
      if (warnings > maxWarnings) {
        states.set(key, { warnings, eliminated: true });
        return {
          status: 'eliminated',
          changed: true,
          warnings,
          warningsRemaining: 0,
          metersOutside: outside,
        };
      }
      states.set(key, { warnings, eliminated: false });
      return {
        status: 'warned',
        changed: true,
        warnings,
        warningsRemaining: maxWarnings - warnings,
        metersOutside: outside,
      };
    },

    forget(gameId, playerId) {
      if (playerId !== undefined) {
        states.delete(`${gameId}:${playerId}`);
        return;
      }
      const prefix = `${gameId}:`;
      for (const key of states.keys()) {
        if (key.startsWith(prefix)) states.delete(key);
      }
    },
  };
}
