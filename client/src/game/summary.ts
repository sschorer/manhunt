/**
 * End-of-game summary wire types and the pure maths the end screen renders from
 * them (BACKLOG.md #19). The types are the shared wire protocol's, so the payload
 * of the `game_over` broadcast decodes to exactly these types.
 *
 * Everything here is pure and derived from the summary the server sends: who won
 * and why, how long the match ran, every catch, and each hider's survival time.
 * The screen shows the survival board and the headline stats straight from it —
 * the client never recomputes the outcome (the server is authoritative).
 */

import type { GameSummary, Winner } from '@manhunt/shared';
import { formatClock } from './matchClock.ts';

export type {
  CatchRecord,
  EndReason,
  GameOverEvent,
  GameSummary,
  HiderOutcome,
  Winner,
} from '@manhunt/shared';

/** The headline for the winning side — "HIDERS WIN" / "HUNTERS WIN". */
export function winTitle(winner: Winner): string {
  return winner === 'hiders' ? 'HIDERS WIN' : 'HUNTERS WIN';
}

/** How many hiders lasted the whole match (never caught). */
export function survivorCount(summary: GameSummary): number {
  return summary.hiders.reduce((n, h) => (h.caught ? n : n + 1), 0);
}

/** The longest any hider lasted, in ms — 0 when there were no hiders. */
export function topSurvivalMs(summary: GameSummary): number {
  return summary.hiders.reduce((best, h) => Math.max(best, h.survivalMs), 0);
}

/**
 * The one-line subtitle under the win headline, phrased for how the match ended:
 * the hiders who ran out the clock, or the hunters who caught them all.
 */
export function outcomeLine(summary: GameSummary): string {
  const clock = formatClock(summary.durationMs);
  if (summary.reason === 'timer') {
    const n = survivorCount(summary);
    const who = n === 1 ? '1 hider survived' : `${n} survived`;
    return `${who} the full ${clock}`;
  }
  return `All hiders caught in ${clock}`;
}
