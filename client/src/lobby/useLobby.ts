import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLOSE_CODES,
  type ErrorAck,
  type Game,
  type GameSummary,
  type InboundEventMap,
  type OkAck,
  type Role,
} from '@manhunt/shared';
import { connectToGame, type GameConnection } from '../transport/gameConnection.ts';

/** The Lobby state and actions exposed to the UI. */
export interface Lobby {
  /** The Game the player is in, or `null` before they create or join one. */
  game: Game | null;
  /** The caller's own player id within {@link game}. */
  playerId: string | null;
  /** Last action error (e.g. a bad Join code), cleared on the next action. */
  error: string | null;
  /** True while a create or join round-trip is in flight. */
  pending: boolean;
  /** The Game's own socket for live play, once its first snapshot has landed. */
  connection: GameConnection | null;
  /**
   * The summary of the Game this Seat is in, once it has ended. It can arrive
   * before the Game itself does: a Seat that comes back to an ended Game is
   * handed the summary and nothing else.
   */
  summary: GameSummary | null;
  createGame(name: string): Promise<void>;
  joinGame(roomCode: string, name: string): Promise<void>;
  setRole(role: Role): void;
  setReady(ready: boolean): void;
  startGame(): void;
  /** Leave the current Game and go back to the join screen. */
  leave(): void;
}

const UNREACHABLE = 'Could not reach the server. Check your connection.';
const REPLACED = 'This Game is now open in another tab.';
const DAILY_LIMIT = "The server's daily limit is used up. It resets at 00:00 UTC.";
const OUTDATED = 'This app is out of date. Close it and open it again to update.';

/** The status the server answers with once its daily request limit is used up. */
const TOO_MANY_REQUESTS = 429;

/** Where the client remembers its Seat across reloads: only the non-secret ids. */
export const SEAT_STORAGE_KEY = 'manhunt.seat';

/**
 * Whether this tab has already reloaded for a `4004`, kept for as long as the
 * tab lives. A build that is still out of date after its reload — a service
 * worker serving the old shell, say — would otherwise reload forever, and every
 * round trip counts against the server's daily limit. The mark is lifted as
 * soon as a Game accepts this build, so a later deploy gets its own reload.
 */
const reloadedForProtocol = {
  key: 'manhunt.reloaded-for-protocol',
  get marked(): boolean {
    return sessionStorage.getItem(this.key) !== null;
  },
  mark(): void {
    sessionStorage.setItem(this.key, '1');
  },
  lift(): void {
    sessionStorage.removeItem(this.key);
  },
};

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

export interface LobbyOptions {
  fetch?: typeof fetch;
  connect?: (gameId: string) => GameConnection;
  /** How the client picks up a new build; tests pass a spy. */
  reload?: () => void;
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);
const defaultConnect = (gameId: string): GameConnection => connectToGame(gameId);
const defaultReload = (): void => location.reload();

/**
 * The Lobby: create or join the Game over HTTP (which sets the Seat cookie), then
 * follow it over the Game's socket, whose first message is the Lobby snapshot.
 * The Seat's ids are kept in `localStorage`, so a reload reconnects to the same
 * Seat.
 */
export function useLobby({
  fetch: doFetch = defaultFetch,
  connect = defaultConnect,
  reload = defaultReload,
}: LobbyOptions = {}): Lobby {
  const [game, setGame] = useState<Game | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(() => readStoredSeat()?.playerId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [connection, setConnection] = useState<GameConnection | null>(null);
  const connectionRef = useRef<GameConnection | null>(null);

  const forget = useCallback(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnection(null);
    setGame(null);
    setPlayerId(null);
    setSummary(null);
  }, []);

  /** Open the Game's socket for a Seat and remember the Seat. */
  const follow = useCallback(
    (seat: StoredSeat): GameConnection => {
      connectionRef.current?.close();
      localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify(seat));
      const connection = connect(seat.gameId);
      connectionRef.current = connection;
      // A connection that was replaced or left no longer speaks for this hook.
      const current = () => connectionRef.current === connection;
      connection.on('lobby_update', ({ game: next }) => {
        if (!current() || next.id !== seat.gameId) return;
        setGame(next);
        // The Game spoke our protocol, so this build is current after all.
        reloadedForProtocol.lift();
        // After a reload, the first snapshot is when the connection becomes usable.
        setConnection(connection);
      });
      // Listened for from the moment the socket opens: a Seat that comes back to
      // an ended Game gets the summary as its only message, before any Lobby.
      connection.on('game_over', ({ gameId, summary: next }) => {
        if (current() && gameId === seat.gameId) setSummary(next);
      });
      connection.onClose((code) => {
        if (!current()) return;
        // `4002` (Game ended) follows the summary, which already shows the end
        // screen. The Seat is still remembered, so a reload shows it again for
        // as long as the Game keeps it.
        if (code === CLOSE_CODES.seatRejected) {
          localStorage.removeItem(SEAT_STORAGE_KEY);
          forget();
        } else if (code === CLOSE_CODES.replaced) {
          forget();
          setError(REPLACED);
        } else if (code === CLOSE_CODES.protocolOutdated) {
          // The Seat is still good; only this build is behind the server's.
          forget();
          if (reloadedForProtocol.marked) {
            setError(OUTDATED);
            return;
          }
          reloadedForProtocol.mark();
          reload();
        }
      });
      return connection;
    },
    [connect, forget, reload],
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
        // Out of daily quota: the server answers this itself, without a body of ours.
        if (res.status === TOO_MANY_REQUESTS) {
          setError(DAILY_LIMIT);
          return;
        }
        const body = (await res.json()) as { game: Game; playerId: string } | ErrorAck;
        if (!res.ok || !('game' in body)) {
          setError('error' in body ? body.error : UNREACHABLE);
          return;
        }
        setConnection(follow({ gameId: body.game.id, playerId: body.playerId }));
        setSummary(null);
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
    setConnection(null);
    localStorage.removeItem(SEAT_STORAGE_KEY);
    setGame(null);
    setPlayerId(null);
    setSummary(null);
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

  return {
    game,
    playerId,
    error,
    pending,
    connection,
    summary,
    createGame,
    joinGame,
    setRole,
    setReady,
    startGame,
    leave,
  };
}
