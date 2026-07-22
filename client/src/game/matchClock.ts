/**
 * Pure match-timing maths for the in-game HUD: how long is left, how long a
 * hider has survived, and how long until the next ping reveal. Everything is
 * derived from the match's `startedAt` and two fixed cadences, so the client can
 * render live countdowns without the server streaming a clock — it only needs to
 * know when the match began.
 *
 * The two durations mirror the server's defaults by hand (the client and server
 * workspaces don't share a package): `DEFAULT_GAME_DURATION_MS` and
 * `DEFAULT_PING_INTERVAL_MS` in `server/live/`. They become per-game settings
 * later (BACKLOG.md #27); until the server sends them, these constants keep the
 * client's countdowns aligned with the server's timers.
 */

/** Match length, in milliseconds. Mirrors the server's `DEFAULT_GAME_DURATION_MS` (30 min). */
export const GAME_DURATION_MS = 1_800_000;

/** Ping-reveal cadence, in milliseconds. Mirrors the server's `DEFAULT_PING_INTERVAL_MS` (3 min). */
export const PING_INTERVAL_MS = 180_000;

/** Parse an ISO-8601 stamp to epoch ms, or `null` when it isn't a real time. */
function parse(startedAt: string | undefined): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? null : ms;
}

/** How long the match has been running at `now`, in ms — never negative. */
export function elapsedMs(startedAt: string | undefined, now: number): number {
  const start = parse(startedAt);
  if (start === null) return 0;
  return Math.max(0, now - start);
}

/** Time remaining before the match's duration elapses, in ms — clamped at 0. */
export function timeLeftMs(
  startedAt: string | undefined,
  now: number,
  durationMs: number = GAME_DURATION_MS,
): number {
  return Math.max(0, durationMs - elapsedMs(startedAt, now));
}

/**
 * Time until the next scheduled ping reveal, in ms. Reveals fire on a fixed
 * cadence from the match start, so the countdown is the remainder of the elapsed
 * time within one interval. Always in `(0, intervalMs]` — the moment a reveal
 * fires the countdown resets to a full interval rather than reading zero.
 */
export function nextPingMs(
  startedAt: string | undefined,
  now: number,
  intervalMs: number = PING_INTERVAL_MS,
): number {
  const period = Math.max(1, intervalMs);
  const remainder = elapsedMs(startedAt, now) % period;
  return period - remainder;
}

/**
 * Format a duration in milliseconds as `MM:SS` (zero-padded, clamped at 0). The
 * minute field is not capped, so a duration over an hour still reads correctly.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
