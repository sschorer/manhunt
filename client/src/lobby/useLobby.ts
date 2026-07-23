import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { socket as defaultSocket } from '../socket.ts';
import type { Game, LobbyAck, LobbyUpdate, Role } from './types.ts';

/** The lobby state and actions exposed to the UI. */
export interface Lobby {
  /** The room the player is in, or `null` before they create/join one. */
  game: Game | null;
  /** The caller's own player id within {@link game}. */
  playerId: string | null;
  /** Last action error (e.g. a bad code), cleared on the next action. */
  error: string | null;
  /** True while a create/join/start round-trip is in flight. */
  pending: boolean;
  createGame(name: string): Promise<void>;
  joinGame(roomCode: string, name: string): Promise<void>;
  setRole(role: Role): void;
  setReady(ready: boolean): void;
  startGame(): void;
  /** Leave the current room locally (back to the join screen). */
  leave(): void;
}

/**
 * Drive the lobby over the socket: emit create/join/role/ready/start actions and
 * keep the local room in sync with the server's `lobby_update` broadcasts. The
 * server is authoritative — every action's ack, and every broadcast, replaces
 * the local game wholesale.
 */
export function useLobby(socket: Socket = defaultSocket): Lobby {
  const [game, setGame] = useState<Game | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  // The per-session secret the server minted at create/join; presented to
  // `resume` after a reconnect so the server can prove we're the same player and
  // not just a room member who has seen our (public) id (BACKLOG.md #24).
  const [resumeToken, setResumeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Follow the room after we've joined it: the server pushes the full roster on
  // every change, so we only accept updates for the game we're actually in.
  useEffect(() => {
    const onUpdate = ({ game: next }: LobbyUpdate): void => {
      setGame((current) => (current && current.id === next.id ? next : current));
    };
    socket.on('lobby_update', onUpdate);
    return () => {
      socket.off('lobby_update', onUpdate);
    };
  }, [socket]);

  // Reclaim our membership after a reconnect (BACKLOG.md #24). A dropped socket
  // auto-reconnects as a fresh socket the server has dropped from the room, so
  // its `position_update`/`claim_catch` would be ignored until we re-identify.
  // On every `connect` after we've joined a room, `resume` re-binds our identity
  // (the server held our slot through its grace period) and refreshes the roster
  // — which may have changed while we were away (e.g. the host reassigned). The
  // very first connect predates any membership, so it's a no-op. Refs keep the
  // latest ids without re-subscribing the handler on every roster change.
  const gameRef = useRef(game);
  const playerIdRef = useRef(playerId);
  const resumeTokenRef = useRef(resumeToken);
  useEffect(() => {
    gameRef.current = game;
    playerIdRef.current = playerId;
    resumeTokenRef.current = resumeToken;
  }, [game, playerId, resumeToken]);
  useEffect(() => {
    const onConnect = (): void => {
      const current = gameRef.current;
      const id = playerIdRef.current;
      const token = resumeTokenRef.current;
      if (!current || !id || !token) return;
      void socket
        .emitWithAck('resume', { gameId: current.id, playerId: id, resumeToken: token })
        .then((ack: LobbyAck) => {
          if (ack.ok) {
            // Only adopt the refreshed roster if we're still in the same game.
            setGame((cur) => (cur && cur.id === ack.game.id ? ack.game : cur));
            return;
          }
          // The match ended while we were away (we missed `game_over`): reset to
          // the join screen rather than sit on a stale, over match. Any other
          // rejection (the slot was already released) leaves the last-known state
          // on screen for the player to leave from.
          if (ack.code === 'game_ended') {
            setGame(null);
            setPlayerId(null);
            setResumeToken(null);
          }
        })
        .catch(() => {
          // Transient — the socket will fire `connect` again on the next retry.
        });
    };
    socket.on('connect', onConnect);
    return () => {
      socket.off('connect', onConnect);
    };
  }, [socket]);

  const enter = useCallback(
    async (event: 'create_game' | 'join_game', payload: unknown): Promise<void> => {
      setPending(true);
      setError(null);
      try {
        const ack = (await socket.emitWithAck(event, payload)) as LobbyAck;
        if (ack.ok) {
          setGame(ack.game);
          setPlayerId(ack.playerId);
          setResumeToken(ack.resumeToken ?? null);
        } else {
          setError(ack.error);
        }
      } catch {
        setError('Could not reach the server. Check your connection.');
      } finally {
        setPending(false);
      }
    },
    [socket],
  );

  const createGame = useCallback(
    (name: string) => enter('create_game', { name }),
    [enter],
  );

  const joinGame = useCallback(
    (roomCode: string, name: string) => enter('join_game', { roomCode, name }),
    [enter],
  );

  // Fire-and-forget actions: the resulting lobby_update refreshes our state, so
  // we only surface an ack error if one comes back.
  const act = useCallback(
    (event: string, payload: unknown): void => {
      setError(null);
      void socket
        .emitWithAck(event, payload)
        .then((ack: LobbyAck) => {
          if (!ack.ok) setError(ack.error);
        })
        .catch(() => setError('Could not reach the server. Check your connection.'));
    },
    [socket],
  );

  const setRole = useCallback((role: Role) => act('set_role', { role }), [act]);
  const setReady = useCallback((ready: boolean) => act('set_ready', { ready }), [act]);
  const startGame = useCallback(() => act('start_game', {}), [act]);

  const leave = useCallback(() => {
    // Tell the server so it removes us from the room (the socket stays open);
    // otherwise we'd linger in the roster until the socket actually disconnects.
    socket.emit('leave_game');
    setGame(null);
    setPlayerId(null);
    setResumeToken(null);
    setError(null);
  }, [socket]);

  return { game, playerId, error, pending, createGame, joinGame, setRole, setReady, startGame, leave };
}
