import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { socket as defaultSocket } from '../socket.ts';
import type { GameOverEvent, GameSummary } from './summary.ts';

/** The socket event this hook speaks, mirrored from `server/protocol/messages.ts`. */
const GAME_OVER = 'game_over';

/**
 * Listen for the server's `game_over` broadcast and hold the end-of-game summary
 * for the current game (BACKLOG.md #15, #19). The server ends a match exactly
 * once — when the last hider is caught or the timer runs out — and emits the
 * summary the end screen renders; this hook latches it so the UI can switch from
 * the live map to the game-over screen.
 *
 * Scoped to `gameId`: a summary for a different game is ignored, and changing
 * (or clearing) the game resets the latch so a fresh match starts clean and a
 * stale summary can't flash the end screen over a new game.
 */
export function useGameOver(gameId: string | null, socket: Socket = defaultSocket): GameSummary | null {
  const [summary, setSummary] = useState<GameSummary | null>(null);

  useEffect(() => {
    if (!gameId) return;

    const onGameOver = (event: GameOverEvent): void => {
      if (event.gameId !== gameId) return;
      setSummary(event.summary);
    };
    socket.on(GAME_OVER, onGameOver);

    return () => {
      socket.off(GAME_OVER, onGameOver);
      // Drop the latched summary so a changed/cleared game starts clean and this
      // one's summary can't flash the end screen over the next match.
      setSummary(null);
    };
  }, [gameId, socket]);

  return summary;
}
