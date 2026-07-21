import { useCallback, useEffect, useState } from 'react';
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

  const enter = useCallback(
    async (event: 'create_game' | 'join_game', payload: unknown): Promise<void> => {
      setPending(true);
      setError(null);
      try {
        const ack = (await socket.emitWithAck(event, payload)) as LobbyAck;
        if (ack.ok) {
          setGame(ack.game);
          setPlayerId(ack.playerId);
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
    setGame(null);
    setPlayerId(null);
    setError(null);
  }, []);

  return { game, playerId, error, pending, createGame, joinGame, setRole, setReady, startGame, leave };
}
