import type { GameConfig } from './game/game.ts';

/**
 * The Worker variables that override the game's rules, each in seconds. On
 * Cloudflare they are `vars`; on the Docker target they are workerd
 * `fromEnvironment` bindings, which bind to null when the variable isn't set.
 */
export interface RuleVariables {
  DISCONNECT_GRACE_S?: string | null;
  PING_INTERVAL_S?: string | null;
  GAME_DURATION_S?: string | null;
}

/** Milliseconds from a variable in seconds, or `undefined` when it is unset or out of range. */
function milliseconds(raw: string | null | undefined, { allowZero }: { allowZero: boolean }): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0 || (seconds === 0 && !allowZero)) return undefined;
  return Math.trunc(seconds * 1000);
}

/**
 * The rule overrides set as Worker variables. A blank or invalid value keeps the
 * game's default; a Grace period of 0 releases a dropped Seat right away.
 */
export function gameConfigFrom(vars: RuleVariables): GameConfig {
  const graceMs = milliseconds(vars.DISCONNECT_GRACE_S, { allowZero: true });
  const pingIntervalMs = milliseconds(vars.PING_INTERVAL_S, { allowZero: false });
  const gameDurationMs = milliseconds(vars.GAME_DURATION_S, { allowZero: false });
  return {
    ...(graceMs === undefined ? {} : { graceMs }),
    ...(pingIntervalMs === undefined ? {} : { pingIntervalMs }),
    ...(gameDurationMs === undefined ? {} : { gameDurationMs }),
  };
}
