/**
 * Lobby wire types, mirroring the server's `server/lobby/rooms.ts`. The two
 * workspaces don't share a package, so these are kept in sync by hand — the
 * shapes are small and change rarely.
 */

export type Role = 'hunter' | 'hider';
export type GameStatus = 'lobby' | 'active' | 'ended';

export interface Player {
  id: string;
  name: string;
  role: Role;
  ready: boolean;
  isHost: boolean;
}

export interface Game {
  id: string;
  roomCode: string;
  status: GameStatus;
  players: Player[];
  createdAt: string;
  startedAt?: string;
}

/** Ack returned by every lobby action. */
export type LobbyAck =
  | { ok: true; game: Game; playerId: string }
  | { ok: false; error: string; code?: string };

/** Payload of the server's `lobby_update` broadcast. */
export interface LobbyUpdate {
  game: Game;
}
