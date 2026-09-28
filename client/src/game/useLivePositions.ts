import { useEffect, useState } from 'react';
import {
  OUTBOUND_EVENTS,
  type GameStateEvent,
  type Position,
  type PositionsByPlayer,
} from '@manhunt/shared';
import type { GameConnection } from '../transport/gameConnection.ts';

/** One player's latest position, as broadcast in `game_state`. */
export type LivePosition = Position;

/** Latest position per player id, for the current game. */
export type LivePositions = PositionsByPlayer;

/** The live view a client keeps for the current game. */
export interface LiveView {
  /** Latest position per player id, exactly what this player is permitted to see. */
  positions: LivePositions;
  /**
   * Increments on every ping-reveal broadcast (BACKLOG.md #13), and stays flat
   * on ordinary ticks. A component can watch it to react to a reveal — a hunter
   * flashing the freshly-disclosed hiders, a hider flagging that they were seen —
   * without diffing positions. `0` until the first reveal.
   */
  revealSeq: number;
}

/**
 * Follow a Game's live positions over its own socket: keep the latest per-player
 * positions from every `game_state` message for that Game. The Game is
 * authoritative and already applies per-role visibility filtering, so whatever
 * arrives here is exactly what this player is permitted to see (BACKLOG.md #14).
 *
 * The connection carries this one Game, so there is nothing to subscribe to; a
 * reconnect is handed a fresh `game_state` by the Game itself.
 */
export function useLivePositions(
  gameId: string | null,
  connection: GameConnection | null,
): LiveView {
  const [positions, setPositions] = useState<LivePositions>({});
  const [revealSeq, setRevealSeq] = useState(0);

  useEffect(() => {
    if (!gameId || !connection) return;

    const onState = (event: GameStateEvent): void => {
      if (event.gameId !== gameId) return;
      setPositions(event.positions ?? {});
      if (event.reveal) setRevealSeq((n) => n + 1);
    };

    const unsubscribe = connection.on(OUTBOUND_EVENTS.gameState, onState);

    return () => {
      unsubscribe();
      // Drop stale state so a later game starts from a clean slate.
      setPositions({});
      setRevealSeq(0);
    };
  }, [gameId, connection]);

  return { positions, revealSeq };
}
