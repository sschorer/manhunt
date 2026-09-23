import type { GameConfig } from './game/game.ts';

/** The Worker variables that override the game's rules, each in seconds. */
export interface RuleVariables {
  DISCONNECT_GRACE_S?: string;
  PING_INTERVAL_S?: string;
  GAME_DURATION_S?: string;
}

/** Milliseconds from a variable in seconds, or `undefined` when it is unset or out of range. */
function milliseconds(raw: string | undefined, { allowZero }: { allowZero: boolean }): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
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
