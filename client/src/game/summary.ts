/**
 * End-of-game summary wire types and the pure maths the end screen renders from
 * them (BACKLOG.md #19). Mirrors the server's `server/live/outcome.ts` shapes by
 * hand — the client and server workspaces don't share a package — so the payload
 * of the `game_over` broadcast decodes to exactly these types.
 *
 * Everything here is pure and derived from the summary the server sends: who won
 * and why, how long the match ran, every catch, and each hider's survival time.
 * The screen shows the survival board and the headline stats straight from it —
 * the client never recomputes the outcome (the server is authoritative).
 */

import { formatClock } from './matchClock.ts';

/** Which side won the match. */
export type Winner = 'hunters' | 'hiders';

/**
 * Why the match ended. `all_caught` — the last hider was caught (hunters win);
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
 * The end-of-game summary — the payload the `game_over` broadcast carries and the
 * end screen renders. Winner and why, the match's span, every catch, and each
 * original hider's outcome (longest-lasting first, as the server sorts them).
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

/** Payload of the server's `game_over` broadcast. */
export interface GameOverEvent {
  gameId: string;
  summary: GameSummary;
}

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
