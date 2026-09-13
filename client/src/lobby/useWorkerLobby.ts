import { useCallback, useEffect, useRef, useState } from 'react';
import { CLOSE_CODES, type ErrorAck, type Game, type InboundEventMap, type OkAck, type Role } from '@manhunt/shared';
import { connectToGame, type GameConnection } from '../transport/gameConnection.ts';
import type { Lobby } from './useLobby.ts';

const UNREACHABLE = 'Could not reach the server. Check your connection.';

/** The Lobby actions sent as requests over the Game's socket. */
type LobbyRequest = 'set_role' | 'set_ready' | 'start_game';

export interface WorkerLobbyOptions {
  fetch?: typeof fetch;
  connect?: (gameId: string) => GameConnection;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultConnect = (gameId: string): GameConnection => connectToGame(gameId);

/**
 * The Lobby on the new Worker backend: create the Game over HTTP (which sets the
 * Seat cookie), then follow it over the Game's socket, whose first message is
 * the Lobby snapshot. Same interface as {@link useLobby}.
 */
export function useWorkerLobby({
  fetch: doFetch = defaultFetch,
  connect = defaultConnect,
}: WorkerLobbyOptions = {}): Lobby {
  const [game, setGame] = useState<Game | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const connectionRef = useRef<GameConnection | null>(null);

  const forget = useCallback(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
    setGame(null);
    setPlayerId(null);
  }, []);

  useEffect(() => () => connectionRef.current?.close(), []);

  const createGame = useCallback(
    async (name: string): Promise<void> => {
      setPending(true);
      setError(null);
      try {
        const res = await doFetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const body = (await res.json()) as { game: Game; playerId: string } | ErrorAck;
        if (!res.ok || !('game' in body)) {
          setError('error' in body ? body.error : UNREACHABLE);
          return;
        }

        connectionRef.current?.close();
        const connection = connect(body.game.id);
        connectionRef.current = connection;
        connection.on('lobby_update', ({ game: next }) => {
          setGame((current) => (current && current.id === next.id ? next : current));
        });
        connection.onClose((code) => {
          if (code === CLOSE_CODES.seatRejected) forget();
        });
        setGame(body.game);
        setPlayerId(body.playerId);
      } catch {
        setError(UNREACHABLE);
      } finally {
        setPending(false);
      }
    },
    [doFetch, connect, forget],
  );

  const joinGame = useCallback(async (): Promise<void> => {
    setError('Joining a Game is not available on the new backend yet.');
  }, []);

  const send = useCallback(<K extends LobbyRequest>(name: K, payload: InboundEventMap[K]): void => {
    const connection = connectionRef.current;
    if (!connection) return;
    setError(null);
    connection
      .request<OkAck>(name, payload)
      .then((ack) => {
        if (!ack.ok) setError(ack.error);
      })
      .catch(() => setError(UNREACHABLE));
  }, []);

  const setRole = useCallback((role: Role) => send('set_role', { role }), [send]);
  const setReady = useCallback((ready: boolean) => send('set_ready', { ready }), [send]);
  const startGame = useCallback(() => send('start_game', {}), [send]);

  const leave = useCallback(() => {
    forget();
    setError(null);
  }, [forget]);

  return { game, playerId, error, pending, createGame, joinGame, setRole, setReady, startGame, leave };
}
