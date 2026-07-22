/**
 * The lobby manager: room lifecycle for the pre-game screen — create a room
 * (returning a short join code), join by code, assign hunter/hider roles,
 * ready-up, and let the host start the match.
 *
 * This is ephemeral hot state, like the live-position store (see
 * `server/live/positions.ts`): a lobby only matters while players are gathering.
 * It is kept in-process here; durable game/player rows in PostgreSQL (see
 * docs/arc42.md §5) are written by the persistence layer, which is out of scope
 * for this milestone.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { BoundaryCircle } from '../live/boundary.ts';

/** Which side a player is on. */
export type Role = 'hunter' | 'hider';

/** Lifecycle of a game, mirroring the `games.status` column. */
export type GameStatus = 'lobby' | 'active' | 'ended';

/** A participant in a lobby. */
export interface Player {
  id: string;
  name: string;
  role: Role;
  /** Whether the player has readied up. */
  ready: boolean;
  /** The host created the room and is the only one who may start it. */
  isHost: boolean;
}

/** A room and everyone in it. */
export interface Game {
  id: string;
  /** Short human-typed join code (see {@link ROOM_CODE_ALPHABET}). */
  roomCode: string;
  status: GameStatus;
  players: Player[];
  /**
   * The circular play area the rules engine geofences against (BACKLOG.md #11).
   * Optional: a game with no boundary is simply unenforced. Mirrors the
   * `games.boundary` column; set by the host via {@link LobbyManager.setBoundary}.
   */
  boundary?: BoundaryCircle;
  createdAt: string;
  startedAt?: string;
}

/** Error codes surfaced to the client so it can show a specific message. */
export type LobbyErrorCode =
  | 'name_required'
  | 'game_not_found'
  | 'player_not_found'
  | 'not_host'
  | 'already_started'
  | 'not_ready';

/** A recoverable lobby-operation failure, translated to a socket ack error. */
export class LobbyError extends Error {
  readonly code: LobbyErrorCode;

  constructor(code: LobbyErrorCode, message: string) {
    super(message);
    this.name = 'LobbyError';
    this.code = code;
  }
}

/**
 * Unambiguous room-code alphabet: uppercase letters and digits with the
 * lookalike characters removed (`I`, `O`, `0`, `1`), so a code read aloud or
 * typed on a phone is hard to get wrong.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

/** Longest accepted display name, to keep the roster tidy and bound payloads. */
export const MAX_NAME_LENGTH = 24;

/** Minimum players before a match can start (at least a hunter and a hider). */
export const MIN_PLAYERS_TO_START = 2;

function randomCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Trim and validate a display name, throwing {@link LobbyError} if empty. */
function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new LobbyError('name_required', 'A name is required');
  return name.slice(0, MAX_NAME_LENGTH);
}

/** Normalize a typed join code (case- and whitespace-insensitive). */
export function normalizeRoomCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/**
 * A match can start once at least {@link MIN_PLAYERS_TO_START} players have all
 * readied up AND both sides are represented (at least one hunter and one hider)
 * — an all-hunter or all-hider room is not a playable game. Exposed so the client
 * can enable the host's start button with the same rule the server enforces.
 */
export function canStart(game: Game): boolean {
  return (
    game.status === 'lobby' &&
    game.players.length >= MIN_PLAYERS_TO_START &&
    game.players.every((p) => p.ready) &&
    game.players.some((p) => p.role === 'hunter') &&
    game.players.some((p) => p.role === 'hider')
  );
}

/** Reads and mutates in-progress lobbies. All lookups are by opaque id. */
export interface LobbyManager {
  /** Create a room; the creator becomes the host (a hunter, not yet ready). */
  createGame(hostName: unknown): { game: Game; player: Player };
  /** Join an existing room by code as a hider. */
  joinGame(roomCode: unknown, name: unknown): { game: Game; player: Player };
  /** Switch a player's own side. */
  setRole(gameId: string, playerId: string, role: Role): Game;
  /** Host-only: define (or replace) the play area the rules engine enforces. */
  setBoundary(gameId: string, playerId: string, boundary: BoundaryCircle): Game;
  /** Toggle a player's ready flag. */
  setReady(gameId: string, playerId: string, ready: boolean): Game;
  /**
   * Convert a caught hider to a hunter — the authoritative role switch a
   * confirmed catch triggers during active play (BACKLOG.md #12). Unlike
   * {@link LobbyManager.setRole} this is a rules-engine outcome, not a lobby
   * choice, so it applies while the game is `active`. Idempotent: flipping a
   * player who is already a hunter is a no-op.
   */
  catchPlayer(gameId: string, targetId: string): Game;
  /** Host-only: move the room from `lobby` to `active`. */
  startGame(gameId: string, playerId: string): Game;
  /**
   * Remove a player (e.g. on disconnect). Reassigns the host and deletes the
   * room once empty. Returns the updated game, or `undefined` if it's now gone.
   */
  removePlayer(gameId: string, playerId: string): Game | undefined;
  get(gameId: string): Game | undefined;
  getByCode(roomCode: unknown): Game | undefined;
}

/**
 * In-process lobby manager. A single instance is fully functional; a
 * multi-instance deployment would back this with Redis, mirroring the split in
 * `server/live/` — that isn't needed until the game is horizontally scaled.
 */
export function createMemoryLobby(): LobbyManager {
  const games = new Map<string, Game>();
  const codes = new Map<string, string>(); // roomCode -> gameId

  function uniqueCode(): string {
    // Collisions are vanishingly rare at this scale; retry a bounded number of
    // times, then widen the code so we never loop forever.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = randomCode(ROOM_CODE_LENGTH);
      if (!codes.has(code)) return code;
    }
    let code: string;
    do {
      code = randomCode(ROOM_CODE_LENGTH + 1);
    } while (codes.has(code));
    return code;
  }

  function getGameOrThrow(gameId: string): Game {
    const game = games.get(gameId);
    if (!game) throw new LobbyError('game_not_found', 'Game not found');
    return game;
  }

  function requirePlayer(game: Game, playerId: string): Player {
    const player = game.players.find((p) => p.id === playerId);
    if (!player) throw new LobbyError('player_not_found', 'Player not found');
    return player;
  }

  return {
    createGame(hostName) {
      const name = cleanName(hostName);
      const game: Game = {
        id: randomUUID(),
        roomCode: uniqueCode(),
        status: 'lobby',
        players: [],
        createdAt: new Date().toISOString(),
      };
      const player: Player = {
        id: randomUUID(),
        name,
        role: 'hunter',
        ready: false,
        isHost: true,
      };
      game.players.push(player);
      games.set(game.id, game);
      codes.set(game.roomCode, game.id);
      return { game, player };
    },

    joinGame(roomCode, name) {
      const gameId = codes.get(normalizeRoomCode(roomCode));
      const game = gameId ? games.get(gameId) : undefined;
      if (!game) throw new LobbyError('game_not_found', 'No room with that code');
      if (game.status !== 'lobby') {
        throw new LobbyError('already_started', 'That game has already started');
      }
      const player: Player = {
        id: randomUUID(),
        name: cleanName(name),
        role: 'hider',
        ready: false,
        isHost: false,
      };
      game.players.push(player);
      return { game, player };
    },

    setRole(gameId, playerId, role) {
      const game = getGameOrThrow(gameId);
      if (game.status !== 'lobby') {
        throw new LobbyError('already_started', 'The game has already started');
      }
      const player = requirePlayer(game, playerId);
      player.role = role;
      return game;
    },

    setBoundary(gameId, playerId, boundary) {
      const game = getGameOrThrow(gameId);
      const player = requirePlayer(game, playerId);
      if (!player.isHost) {
        throw new LobbyError('not_host', 'Only the host can set the play area');
      }
      game.boundary = boundary;
      return game;
    },

    setReady(gameId, playerId, ready) {
      const game = getGameOrThrow(gameId);
      if (game.status !== 'lobby') {
        throw new LobbyError('already_started', 'The game has already started');
      }
      requirePlayer(game, playerId).ready = ready;
      return game;
    },

    catchPlayer(gameId, targetId) {
      const game = getGameOrThrow(gameId);
      requirePlayer(game, targetId).role = 'hunter';
      return game;
    },

    startGame(gameId, playerId) {
      const game = getGameOrThrow(gameId);
      const player = requirePlayer(game, playerId);
      if (!player.isHost) {
        throw new LobbyError('not_host', 'Only the host can start the game');
      }
      if (game.status !== 'lobby') {
        throw new LobbyError('already_started', 'The game has already started');
      }
      if (!canStart(game)) {
        throw new LobbyError(
          'not_ready',
          `Need at least ${MIN_PLAYERS_TO_START} players — a hunter and a hider — all readied up`,
        );
      }
      game.status = 'active';
      game.startedAt = new Date().toISOString();
      return game;
    },

    removePlayer(gameId, playerId) {
      const game = games.get(gameId);
      if (!game) return undefined;
      const wasHost = game.players.find((p) => p.id === playerId)?.isHost;
      game.players = game.players.filter((p) => p.id !== playerId);
      if (game.players.length === 0) {
        games.delete(game.id);
        codes.delete(game.roomCode);
        return undefined;
      }
      // Hand the room to the next-longest-present player so it always has a host.
      if (wasHost && !game.players.some((p) => p.isHost)) {
        game.players[0]!.isHost = true;
      }
      return game;
    },

    get(gameId) {
      return games.get(gameId);
    },

    getByCode(roomCode) {
      const gameId = codes.get(normalizeRoomCode(roomCode));
      return gameId ? games.get(gameId) : undefined;
    },
  };
}
