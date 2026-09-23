import { useEffect, useState } from 'react';
import {
  OUTBOUND_EVENTS,
  type BoundaryWarningEvent,
  type PlayerEliminatedEvent,
} from '@manhunt/shared';
import type { GameConnection } from '../transport/gameConnection.ts';

/** What the Game last said about the Boundary, for the match screen to show. */
export interface BoundaryEvents {
  /**
   * The latest warning, which is always about us: the Game checks every
   * accepted fix and warns the offending player personally.
   */
  warning: BoundaryWarningEvent | null;
  /** The latest Elimination in this Game, whoever it was. */
  elimination: PlayerEliminatedEvent | null;
}

/**
 * Follow what the Game says about its Boundary: the warning we get for leaving
 * it, and every Elimination that follows one (`server/CONTEXT.md` "Boundary",
 * "Elimination").
 *
 * Both are latched with the `at` the Game stamped, so the caller decides how
 * long to show them. Neither is the durable truth about who is out — that is in
 * the roster, which survives a reload and a reconnect.
 *
 * Scoped to `gameId`, and to the Game's own socket on the Worker backend: on the
 * old Socket.IO server nothing shows a warning.
 */
export function useBoundaryEvents(
  gameId: string | null,
  connection?: GameConnection | null,
): BoundaryEvents {
  const [events, setEvents] = useState<BoundaryEvents>({ warning: null, elimination: null });

  useEffect(() => {
    if (!gameId || !connection) return;

    const unsubscribe = [
      connection.on(OUTBOUND_EVENTS.boundaryWarning, (warning) => {
        if (warning.gameId === gameId) setEvents((seen) => ({ ...seen, warning }));
      }),
      connection.on(OUTBOUND_EVENTS.playerEliminated, (elimination) => {
        if (elimination.gameId === gameId) setEvents((seen) => ({ ...seen, elimination }));
      }),
    ];

    return () => {
      for (const off of unsubscribe) off();
      // Drop them so a changed (or left) Game starts clean.
      setEvents({ warning: null, elimination: null });
    };
  }, [gameId, connection]);

  return events;
}
