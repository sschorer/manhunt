/**
 * The ping-reveal scheduler — the rules-engine timer that periodically forces
 * hider positions into the broadcast (BACKLOG.md #13, docs/arc42.md §6.4 "Ping
 * reveal"). Per-role state filtering (BACKLOG.md #14) keeps hunters from ever
 * receiving hider coordinates in the steady state; this scheduler punches a
 * periodic hole in that veil: on a fixed interval it fires a *reveal tick* for a
 * running game, and the transport layer answers by fanning out the game's current
 * positions with the per-role filter lifted — so hunters get a momentary "ping"
 * of where the hiders are, then the veil closes again until the next reveal. This
 * is what stops a hunter from simply camping (docs/arc42.md §8 risk "camping").
 *
 * The scheduler owns only *timing*, not the reveal payload: it fires
 * {@link PingSchedulerOptions.onReveal} with the game id, and the caller decides
 * what to disclose (see `server/app.ts`). Keeping it payload-agnostic mirrors the
 * boundary monitor — pure, focused mechanism the transport wires an effect onto.
 * The timer primitives are injectable so tests can drive reveals deterministically
 * without leaning on real wall-clock timers.
 */

/**
 * Default reveal interval, in milliseconds. Matches the `PING_INTERVAL_S` default
 * (180 s) in `.env.example` and the `games.ping_interval_s` column default in
 * `db/schema.sql`, so the same cadence is described everywhere. Tunable per game
 * once game settings land (BACKLOG.md #27).
 */
export const DEFAULT_PING_INTERVAL_MS = 180_000;

/**
 * The subset of the timer API the scheduler needs. `setInterval` returns an
 * opaque handle the scheduler stores and later passes back to `clearInterval`;
 * its concrete type is deliberately hidden behind `unknown` so a fake (or the
 * global timers) can supply whatever handle it likes. Defaults to the global
 * timers, un-refed so a scheduled reveal never keeps the process alive on its own.
 */
export interface PingTimerApi {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: PingTimerApi = {
  setInterval: (handler, ms) => setInterval(handler, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Tunables for {@link createPingScheduler}. */
export interface PingSchedulerOptions {
  /**
   * Called once per reveal tick for a running game, with that game's id. The
   * caller reads the game's current positions and broadcasts them with the
   * per-role filter lifted (a reveal). Kept synchronous-in, effect-out: the
   * scheduler doesn't await it, so a slow or throwing handler can't wedge the
   * timer — the caller is responsible for catching its own async failures.
   */
  onReveal: (gameId: string) => void;
  /**
   * Milliseconds between reveals. Defaults to {@link DEFAULT_PING_INTERVAL_MS}.
   * Coerced to a positive integer so a zero/negative/fractional config can't make
   * a nonsensical timer.
   */
  intervalMs?: number;
  /** Timer primitives; injected in tests for deterministic reveals. */
  timers?: PingTimerApi;
}

/** Per-game reveal timer. Starts on game start, stops on teardown. */
export interface PingScheduler {
  /**
   * Begin periodic reveals for a game. Idempotent — starting an already-running
   * game is a no-op, so a double `start_game` (reconnect race, double-submit)
   * can't stack two timers on one game.
   */
  start(gameId: string): void;
  /** Stop reveals for a game (it ended, or the room emptied). A no-op if not running. */
  stop(gameId: string): void;
  /** Whether a game currently has reveals scheduled. */
  isRunning(gameId: string): boolean;
  /** Stop every game's reveals — full teardown (server shutdown, test cleanup). */
  stopAll(): void;
}

/**
 * Build a ping-reveal scheduler. State is one interval handle per running game,
 * keyed by game id; {@link PingScheduler.stop}/{@link PingScheduler.stopAll} clear
 * them so no timer outlives the game it reveals.
 */
export function createPingScheduler({
  onReveal,
  intervalMs = DEFAULT_PING_INTERVAL_MS,
  timers = defaultTimers,
}: PingSchedulerOptions): PingScheduler {
  const period = Math.max(1, Math.trunc(intervalMs));
  const handles = new Map<string, unknown>();

  return {
    start(gameId) {
      if (handles.has(gameId)) return;
      handles.set(
        gameId,
        timers.setInterval(() => onReveal(gameId), period),
      );
    },
    stop(gameId) {
      const handle = handles.get(gameId);
      if (!handles.has(gameId)) return;
      timers.clearInterval(handle);
      handles.delete(gameId);
    },
    isRunning(gameId) {
      return handles.has(gameId);
    },
    stopAll() {
      for (const handle of handles.values()) timers.clearInterval(handle);
      handles.clear();
    },
  };
}
