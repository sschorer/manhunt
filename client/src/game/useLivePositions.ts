import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * The socket events this hook speaks, mirrored by hand from the server's
 * `server/protocol/messages.ts` (the client and server workspaces don't share a
 * package). `join` subscribes this socket to a game's broadcasts; `game_state`
 * carries the latest per-player positions the server fans out to the room.
 */
const JOIN = 'join';
const GAME_STATE = 'game_state';

/** One player's latest position, as broadcast in `game_state`. */
export interface LivePosition {
  lat: number;
  lng: number;
  /** When the server recorded it (ISO-8601). */
  recordedAt: string;
}

/** Latest position per player id, for the current game. */
export type LivePositions = Record<string, LivePosition>;

/** Payload of the server's `game_state` broadcast. */
interface GameStateEvent {
  gameId: string;
  positions: LivePositions;
}

/**
 * Follow a game's live positions over the socket. On mount it (re-)subscribes
 * the socket to the game's broadcasts and then keeps the latest per-player
 * positions from every `game_state` message for that game. The server is
 * authoritative and already applies per-role visibility filtering, so whatever
 * arrives here is exactly what this player is permitted to see (BACKLOG.md #14).
 *
 * The socket is normally already in the room via its lobby membership; emitting
 * `join` again is idempotent and covers a socket that reconnected straight into
 * an active match.
 */
export function useLivePositions(gameId: string | null, socket: Socket): LivePositions {
  const [positions, setPositions] = useState<LivePositions>({});

  useEffect(() => {
    if (!gameId) return;

    socket.emit(JOIN, { gameId });

    const onState = (event: GameStateEvent): void => {
      if (event.gameId !== gameId) return;
      setPositions(event.positions ?? {});
    };
    socket.on(GAME_STATE, onState);

    return () => {
      socket.off(GAME_STATE, onState);
      // Drop stale positions so a later game starts from a clean slate.
      setPositions({});
    };
  }, [gameId, socket]);

  return positions;
}
