import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  INBOUND_EVENTS,
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
 * Follow a game's live positions over the socket. On mount it (re-)subscribes
 * the socket to the game's broadcasts and then keeps the latest per-player
 * positions from every `game_state` message for that game. The server is
 * authoritative and already applies per-role visibility filtering, so whatever
 * arrives here is exactly what this player is permitted to see (BACKLOG.md #14).
 *
 * The socket is normally already in the room via its lobby membership; emitting
 * `join` again is idempotent. It is also re-emitted on every `connect`, because
 * a reconnect gets a fresh socket that the server has dropped from the room —
 * without re-joining, `game_state` would stop for the rest of the match.
 *
 * On the Worker backend, `connection` is the Game's own socket: it only carries
 * this Game, so there is nothing to join.
 */
export function useLivePositions(
  gameId: string | null,
  socket: Socket,
  connection?: GameConnection | null,
): LiveView {
  const [positions, setPositions] = useState<LivePositions>({});
  const [revealSeq, setRevealSeq] = useState(0);

  useEffect(() => {
    if (!gameId) return;

    const onState = (event: GameStateEvent): void => {
      if (event.gameId !== gameId) return;
      setPositions(event.positions ?? {});
      if (event.reveal) setRevealSeq((n) => n + 1);
    };

    let unsubscribe: () => void;
    if (connection) {
      unsubscribe = connection.on(OUTBOUND_EVENTS.gameState, onState);
    } else {
      const join = (): void => {
        socket.emit(INBOUND_EVENTS.join, { gameId });
      };
      join();
      socket.on('connect', join);
      socket.on(OUTBOUND_EVENTS.gameState, onState);
      unsubscribe = () => {
        socket.off('connect', join);
        socket.off(OUTBOUND_EVENTS.gameState, onState);
      };
    }

    return () => {
      unsubscribe();
      // Drop stale state so a later game starts from a clean slate.
      setPositions({});
      setRevealSeq(0);
    };
  }, [gameId, socket, connection]);

  return { positions, revealSeq };
}
