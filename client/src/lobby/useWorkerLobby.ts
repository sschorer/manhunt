import { useCallback, useEffect, useRef, useState } from 'react';
import { CLOSE_CODES, type ErrorAck, type Game, type InboundEventMap, type OkAck, type Role } from '@manhunt/shared';
import { connectToGame, type GameConnection } from '../transport/gameConnection.ts';
import type { Lobby } from './useLobby.ts';

const UNREACHABLE = 'Could not reach the server. Check your connection.';
const REPLACED = 'This Game is now open in another tab.';

/** Where the client remembers its Seat across reloads: only the non-secret ids. */
export const SEAT_STORAGE_KEY = 'manhunt.seat';

interface StoredSeat {
  gameId: string;
  playerId: string;
}

function readStoredSeat(): StoredSeat | null {
  try {
    const value = JSON.parse(localStorage.getItem(SEAT_STORAGE_KEY) ?? 'null') as Partial<StoredSeat> | null;
    return typeof value?.gameId === 'string' && typeof value.playerId === 'string'
      ? { gameId: value.gameId, playerId: value.playerId }
      : null;
  } catch {
    return null;
  }
}

/** The Lobby actions sent as requests over the Game's socket. */
type LobbyRequest = 'set_role' | 'set_ready' | 'start_game';

export interface WorkerLobbyOptions {
  fetch?: typeof fetch;
  connect?: (gameId: string) => GameConnection;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultConnect = (gameId: string): GameConnection => connectToGame(gameId);

/**
 * The Lobby on the new Worker backend: create or join the Game over HTTP (which
 * sets the Seat cookie), then follow it over the Game's socket, whose first
 * message is the Lobby snapshot. The Seat's ids are kept in `localStorage`, so a
 * reload reconnects to the same Seat. Same interface as {@link useLobby}.
 */
export function useWorkerLobby({
  fetch: doFetch = defaultFetch,
  connect = defaultConnect,
}: WorkerLobbyOptions = {}): Lobby {
  const [game, setGame] = useState<Game | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(() => readStoredSeat()?.playerId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const connectionRef = useRef<GameConnection | null>(null);

  const forget = useCallback(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
    setGame(null);
    setPlayerId(null);
  }, []);

  /** Open the Game's socket for a Seat and remember the Seat. */
  const follow = useCallback(
    (seat: StoredSeat) => {
      connectionRef.current?.close();
      localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify(seat));
      const connection = connect(seat.gameId);
      connectionRef.current = connection;
      // A connection that was replaced or left no longer speaks for this hook.
      const current = () => connectionRef.current === connection;
      connection.on('lobby_update', ({ game: next }) => {
        if (current() && next.id === seat.gameId) setGame(next);
      });
      connection.onClose((code) => {
        if (!current()) return;
        if (code === CLOSE_CODES.seatRejected) {
          localStorage.removeItem(SEAT_STORAGE_KEY);
          forget();
        } else if (code === CLOSE_CODES.replaced) {
          forget();
          setError(REPLACED);
        }
      });
    },
    [connect, forget],
  );

  useEffect(() => {
    const seat = readStoredSeat();
    if (seat) follow(seat);
    return () => connectionRef.current?.close();
  }, [follow]);

  const enter = useCallback(
    async (path: string, payload: unknown): Promise<void> => {
      setPending(true);
      setError(null);
      try {
        const res = await doFetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = (await res.json()) as { game: Game; playerId: string } | ErrorAck;
        if (!res.ok || !('game' in body)) {
          setError('error' in body ? body.error : UNREACHABLE);
          return;
        }
        follow({ gameId: body.game.id, playerId: body.playerId });
        setGame(body.game);
        setPlayerId(body.playerId);
      } catch {
        setError(UNREACHABLE);
      } finally {
        setPending(false);
      }
    },
    [doFetch, follow],
  );

  const createGame = useCallback((name: string) => enter('/api/games', { name }), [enter]);
  const joinGame = useCallback(
    (code: string, name: string) => enter('/api/games/join', { code, name }),
    [enter],
  );

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
    const connection = connectionRef.current;
    const seat = readStoredSeat();
    connectionRef.current = null;
    localStorage.removeItem(SEAT_STORAGE_KEY);
    setGame(null);
    setPlayerId(null);
    setError(null);
    if (!connection || !seat) {
      connection?.close();
      return;
    }
    // Leave through the Game first, then clear the Seat cookie, even if the
    // request failed: the player chose to go either way.
    void connection
      .request<OkAck>('leave_game', undefined)
      .catch(() => undefined)
      .finally(() => {
        connection.close();
        void doFetch(`/api/games/${encodeURIComponent(seat.gameId)}/seat`, { method: 'DELETE' }).catch(
          () => undefined,
        );
      });
  }, [doFetch]);

  return { game, playerId, error, pending, createGame, joinGame, setRole, setReady, startGame, leave };
}
