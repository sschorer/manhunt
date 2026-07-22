import type { ReactNode } from 'react';
import { formatClock } from './matchClock.ts';

/**
 * The in-game heads-up display: the row of stat tiles above the map, plus (for a
 * hider) the "you'll be revealed soon" banner. Purely presentational — every
 * value is computed by {@link ActiveGame} from the match clock and roster and
 * passed in, so this component is trivial to render in isolation.
 *
 * The two roles read the same match differently, so the HUD is a discriminated
 * union: a hunter watches the clock run down, how many hiders are left, and when
 * the next ping will expose them; a hider watches how long they've survived and
 * counts down to that same ping as a threat.
 */
export type MatchHudProps =
  | {
      role: 'hunter';
      /** Time until the match's duration elapses, in ms. */
      timeLeftMs: number;
      /** Hiders still uncaught. */
      hidersRemaining: number;
      /** Hiders the match started with. */
      hidersTotal: number;
      /** Time until the next ping reveal, in ms. */
      nextPingMs: number;
    }
  | {
      role: 'hider';
      /** How long this hider has lasted so far, in ms. */
      survivedMs: number;
      /** True for a few seconds after a ping reveal exposes this hider. */
      revealed: boolean;
      /** Time until the next ping reveal, in ms. */
      nextPingMs: number;
    };

/** One labelled stat in the HUD row. `tone` tints the value. */
function StatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'teal' | 'alert';
}) {
  return (
    <div className={`stat stat--${tone}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}

export default function MatchHud(props: MatchHudProps) {
  if (props.role === 'hunter') {
    return (
      <div className="hud" data-testid="hunter-hud">
        <StatTile label="TIME LEFT" value={formatClock(props.timeLeftMs)} />
        <StatTile
          label="HIDERS"
          tone="teal"
          value={
            <>
              {props.hidersRemaining}
              <span className="stat__sub"> / {props.hidersTotal}</span>
            </>
          }
        />
        <StatTile label="NEXT PING" tone="alert" value={formatClock(props.nextPingMs)} />
      </div>
    );
  }

  return (
    <div data-testid="hider-hud">
      <div className="hud">
        <StatTile label="SURVIVED" tone="teal" value={formatClock(props.survivedMs)} />
        <StatTile
          label="STATUS"
          tone={props.revealed ? 'alert' : 'teal'}
          value={props.revealed ? 'Revealed' : 'Hidden'}
        />
      </div>
      <p className={`reveal-banner ${props.revealed ? 'reveal-banner--on' : ''}`} role="status">
        <span className="reveal-banner__dot" aria-hidden="true" />
        {props.revealed ? (
          <>Your location was just revealed to the hunters</>
        ) : (
          <>
            Location revealed to hunters in <strong>{formatClock(props.nextPingMs)}</strong>
          </>
        )}
      </p>
    </div>
  );
}
