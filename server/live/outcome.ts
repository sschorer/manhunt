/**
 * Win conditions + end-screen data — the rules-engine end-of-game check
 * (BACKLOG.md #15, docs/arc42.md §5 "Rules engine"). A match ends one of two
 * ways:
 *
 * - **Last hider caught** — every hider has been converted to a hunter
 *   (BACKLOG.md #12). There is no one left to find, so the **hunters win**
 *   (`all_caught`). Detected the moment a confirmed catch flips the final hider.
 * - **Survive the timer** — the game's duration elapses with at least one hider
 *   still uncaught. The remaining hiders lasted the match, so the **hiders win**
 *   (`timer`).
 *
 * Whichever fires first ends the game, and the server produces a summary payload
 * for the end screen (BACKLOG.md #19): who won and why, how long the match ran,
 * every catch that happened, and each hider's survival time. Like every
 * game-affecting decision this is computed server-side and never trusted from the
 * client (docs/arc42.md quality goal #1 "Fairness / authority").
 *
 * Two parts, mirroring the split elsewhere in `server/live/`: a pure summary
 * builder ({@link buildSummary}) that turns recorded facts into the end payload,
 * and a small stateful tracker ({@link createOutcomeTracker}) that remembers a
 * game's start, its original hiders and its catches, and owns the one-shot
 * survive-the-timer countdown. The timer primitives are injectable so tests can
 * fire the timeout deterministically without leaning on real wall-clock time.
 */
import type { Game } from '../lobby/rooms.ts';

/** Which side won the match. */
export type Winner = 'hunters' | 'hiders';

/**
 * Why a match ended. `all_caught` — the last hider was caught (hunters win);
 * `timer` — the duration elapsed with a hider still free (hiders win). Stable
 * codes for the summary payload and the event log (`events.type = 'win'`).
 */
export type EndReason = 'all_caught' | 'timer';

/**
 * Default match duration, in milliseconds. Mirrors the `games.duration_s` column
 * default (1800 s / 30 min) in `db/schema.sql`, so the same length is described
 * everywhere. Tunable per game once game settings land (BACKLOG.md #27).
 */
export const DEFAULT_GAME_DURATION_MS = 1_800_000;

/** The side that wins for a given end reason. */
export function winnerFor(reason: EndReason): Winner {
  return reason === 'all_caught' ? 'hunters' : 'hiders';
}

/**
 * A catch that happened during the match: a hunter caught a hider at a moment in
 * time. The same shape the transport layer broadcasts as `catch_confirmed` (minus
 * the game id), recorded so the summary can list every catch and derive survival
 * times.
 */
export interface CatchRecord {
  hunterId: string;
  targetId: string;
  /** When the server confirmed the catch (ISO-8601). */
  at: string;
}

/** One hider's line on the end screen: whether they were caught and for how long they lasted. */
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
 * The end-of-game summary — the payload the end screen renders (BACKLOG.md #15
 * "produce a summary", #19). Carries the winner and why, the match's span, every
 * catch, and each original hider's survival time (longest-lasting first).
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

/**
 * The subset of the timer API the tracker needs for the survive-the-timer
 * countdown: a one-shot `setTimeout` returning an opaque handle it later passes to
 * `clearTimeout`. The handle type is hidden behind `unknown` so a fake (or the
 * global timers) can supply whatever it likes. Defaults to the global timers,
 * un-refed so a pending countdown never keeps the process alive on its own.
 */
export interface GameTimerApi {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: GameTimerApi = {
  setTimeout: (handler, ms) => setTimeout(handler, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Tunables for {@link createOutcomeTracker}. */
export interface OutcomeTrackerOptions {
  /**
   * Called once when a game's survive-the-timer countdown elapses, with that
   * game's id. The caller ends the game with reason `timer` (hiders win). Not
   * awaited, mirroring the ping scheduler: a slow or throwing handler can't wedge
   * the tracker, so the caller catches its own async failures.
   */
  onExpire: (gameId: string) => void;
  /**
   * Match duration in milliseconds — how long hiders must survive to win. Defaults
   * to {@link DEFAULT_GAME_DURATION_MS}. Coerced to a positive integer so a
   * zero/negative/fractional config can't make a nonsensical timer.
   */
  durationMs?: number;
  /** Timer primitives; injected in tests for a deterministic timeout. */
  timers?: GameTimerApi;
}

/** Per-game end-of-game tracker: remembers the facts a summary needs and owns the survive timer. */
export interface OutcomeTracker {
  /**
   * Begin tracking a started match: snapshot its original hiders and start time,
   * and arm the survive-the-timer countdown. Idempotent — starting an
   * already-tracked game is a no-op, so a double `start_game` can't stack timers or
   * reset the snapshot.
   */
  start(input: { game: Game; startedAt: string }): void;
  /** Record a confirmed catch so it shows in the summary and counts against the hiders. */
  recordCatch(gameId: string, record: CatchRecord): void;
  /**
   * Drop a player who left the game (disconnect / `leave_game`) from the tracker:
   * remove them from the original-hider snapshot so they no longer count toward
   * the last-hider win and are not credited with a survival time in the summary.
   * A no-op for a player who was never a tracked hider, or an untracked game.
   */
  dropPlayer(gameId: string, playerId: string): void;
  /**
   * How many original hiders are still uncaught. `0` means the last hider has been
   * caught — the hunters have won. `0` too for an unknown/untracked game, so a
   * stray check can't be misread as "hiders remain".
   */
  remainingHiders(gameId: string): number;
  /**
   * Finalize a tracked game exactly once: clear its countdown, drop its state, and
   * return the summary. A second call (or a call for an untracked game) returns
   * `undefined`, so the catch path and the timer path can race to end a game and
   * only the first wins.
   */
  end(gameId: string, reason: EndReason, endedAt: string): GameSummary | undefined;
  /** Stop tracking a game and clear its countdown without producing a summary (teardown). */
  stop(gameId: string): void;
  /** Whether a game is currently being tracked. */
  isTracking(gameId: string): boolean;
  /** Stop tracking every game — full teardown (server shutdown, test cleanup). */
  stopAll(): void;
}

/** A tracked game's recorded facts plus its live countdown handle. */
interface TrackedGame {
  startedAt: string;
  initialHiders: { playerId: string; name: string }[];
  catches: CatchRecord[];
  /** Ids of original hiders caught so far — the complement of "still free". */
  caught: Set<string>;
  timer: unknown;
}

/**
 * Build an outcome tracker. State is one {@link TrackedGame} per active game,
 * keyed by game id; {@link OutcomeTracker.end}/{@link OutcomeTracker.stop}/
 * {@link OutcomeTracker.stopAll} clear the countdown so no timer outlives the game
 * it ends.
 */
export function createOutcomeTracker({
  onExpire,
  durationMs = DEFAULT_GAME_DURATION_MS,
  timers = defaultTimers,
}: OutcomeTrackerOptions): OutcomeTracker {
  const period = Math.max(1, Math.trunc(durationMs));
  const games = new Map<string, TrackedGame>();

  function clearTimer(game: TrackedGame): void {
    timers.clearTimeout(game.timer);
  }

  return {
    start({ game, startedAt }) {
      if (games.has(game.id)) return;
      const initialHiders = game.players
        .filter((p) => p.role === 'hider')
        .map((p) => ({ playerId: p.id, name: p.name }));
      games.set(game.id, {
        startedAt,
        initialHiders,
        catches: [],
        caught: new Set(),
        timer: timers.setTimeout(() => onExpire(game.id), period),
      });
    },

    recordCatch(gameId, record) {
      const game = games.get(gameId);
      if (!game) return;
      game.catches.push(record);
      game.caught.add(record.targetId);
    },

    dropPlayer(gameId, playerId) {
      const game = games.get(gameId);
      if (!game) return;
      // Leave the recorded catches intact — a catch that happened is history — but
      // take the departed player out of the hider roster so they neither hold the
      // game open past the last present hider nor earn a survival line at the end.
      game.initialHiders = game.initialHiders.filter((h) => h.playerId !== playerId);
      game.caught.delete(playerId);
    },

    remainingHiders(gameId) {
      const game = games.get(gameId);
      if (!game) return 0;
      return game.initialHiders.reduce(
        (n, h) => (game.caught.has(h.playerId) ? n : n + 1),
        0,
      );
    },

    end(gameId, reason, endedAt) {
      const game = games.get(gameId);
      if (!game) return undefined;
      clearTimer(game);
      games.delete(gameId);
      return buildSummary({
        gameId,
        startedAt: game.startedAt,
        endedAt,
        reason,
        initialHiders: game.initialHiders,
        catches: game.catches,
      });
    },

    stop(gameId) {
      const game = games.get(gameId);
      if (!game) return;
      clearTimer(game);
      games.delete(gameId);
    },

    isTracking(gameId) {
      return games.has(gameId);
    },

    stopAll() {
      for (const game of games.values()) clearTimer(game);
      games.clear();
    },
  };
}
