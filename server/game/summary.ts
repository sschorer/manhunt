/**
 * The end-of-game summary (`server/CONTEXT.md`): who won and why, how long the
 * Game ran, every Catch, and each Hider's survival time. Pure, with no platform
 * imports: the game core builds it and hands it out as an effect.
 */
import type { CatchRecord, EndReason, GameSummary, HiderOutcome, Winner } from '../../shared/index.ts';

/** The side that wins for a given end reason. */
export function winnerFor(reason: EndReason): Winner {
  return reason === 'all_caught' ? 'hunters' : 'hiders';
}

/** Milliseconds between two ISO-8601 stamps, never negative (a clock quirk can't make time run backwards here). */
function elapsedMs(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

/**
 * Build the end-of-game summary from the recorded facts. Pure: the caller supplies
 * the match's start/end, why it ended, the original hider roster, and the catches
 * that happened. A hider's survival time runs from the start to the moment they
 * were caught (or to the game's end if they were never caught); hiders are sorted
 * by survival time descending so the end screen can lead with the longest survivor.
 */
export function buildSummary(input: {
  gameId: string;
  startedAt: string;
  endedAt: string;
  reason: EndReason;
  initialHiders: { playerId: string; name: string }[];
  catches: CatchRecord[];
}): GameSummary {
  const { gameId, startedAt, endedAt, reason, initialHiders, catches } = input;
  // Index the catches by their target so each hider can find its own capture.
  const caughtAtByPlayer = new Map<string, string>();
  for (const c of catches) {
    // Keep the first catch recorded for a player — a hider is caught once.
    if (!caughtAtByPlayer.has(c.targetId)) caughtAtByPlayer.set(c.targetId, c.at);
  }

  const hiders: HiderOutcome[] = initialHiders
    .map(({ playerId, name }) => {
      const caughtAt = caughtAtByPlayer.get(playerId);
      const survivalMs = elapsedMs(startedAt, caughtAt ?? endedAt);
      return caughtAt
        ? { playerId, name, caught: true, survivalMs, caughtAt }
        : { playerId, name, caught: false, survivalMs };
    })
    // Longest survivor first; break ties by name for a stable order.
    .sort((a, b) => b.survivalMs - a.survivalMs || a.name.localeCompare(b.name));

  return {
    gameId,
    winner: winnerFor(reason),
    reason,
    startedAt,
    endedAt,
    durationMs: elapsedMs(startedAt, endedAt),
    catches,
    hiders,
  };
}
