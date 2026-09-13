/**
 * The game core: one instance per Game, from its creation through the Lobby.
 * Plain TypeScript with no platform imports — the host (`server/rooms/GameRoom.ts`)
 * feeds it commands with the current time and carries out the effects it returns.
 * Domain terms follow `server/CONTEXT.md`.
 */
import type { Game, GameStatus, Role, ServerEventFrame } from '../../shared/index.ts';
import { CLOSE_CODES, type CloseCode } from '../../shared/index.ts';

/** Longest accepted player name, to keep the roster tidy and bound payloads. */
export const MAX_NAME_LENGTH = 24;

/** The version of {@link GameSnapshot}; raised when its shape changes. */
export const SNAPSHOT_VERSION = 1;

/** A player's Seat as persisted. `token` is the Seat's secret resume token. */
export interface SeatSnapshot {
  playerId: string;
  name: string;
  role: Role;
  ready: boolean;
  isHost: boolean;
  token: string;
}

/** Everything a Game needs to be restored after its host is evicted. */
export interface GameSnapshot {
  version: typeof SNAPSHOT_VERSION;
  gameId: string;
  joinCode: string;
  status: GameStatus;
  /** Epoch milliseconds. */
  createdAt: number;
  seats: SeatSnapshot[];
}

/** Who a message goes to. */
export type Audience = { seat: string } | { role: Role } | 'everyone';

export type Command = { type: 'seat_reconnected'; playerId: string };

export type Effect =
  | { type: 'send'; to: Audience; message: ServerEventFrame }
  | { type: 'close'; seat: string; code: CloseCode }
  | { type: 'durableChanged' };

export type GameErrorCode = 'name_required' | 'unsupported_snapshot';

/** A rejected operation, with a stable code the host can report. */
export class GameError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

export interface GameCore {
  /** Apply one command at `now` (epoch ms) and return the effects to carry out. */
  apply(command: Command, now: number): Effect[];
  /** The Lobby as players see it: no Seat tokens. */
  lobby(): Game;
  /** The Seat holding this resume token, if any. */
  seatFor(token: string): string | undefined;
  /** A JSON-serializable copy of the durable state. */
  snapshot(): GameSnapshot;
}

/** The Host who creates a Game. The host module mints the id and token. */
export interface NewHost {
  playerId: string;
  name: unknown;
  token: string;
}

export interface GameSetup {
  gameId: string;
  joinCode: string;
  /** Epoch milliseconds. */
  now: number;
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new GameError('name_required', 'A name is required');
  return name.slice(0, MAX_NAME_LENGTH);
}

/** Create a Game in its Lobby, with the Host as a Hunter who is not ready. */
export function createGame(host: NewHost, setup: GameSetup): GameCore {
  return fromSnapshot({
    version: SNAPSHOT_VERSION,
    gameId: setup.gameId,
    joinCode: setup.joinCode,
    status: 'lobby',
    createdAt: setup.now,
    seats: [
      {
        playerId: host.playerId,
        name: cleanName(host.name),
        role: 'hunter',
        ready: false,
        isHost: true,
        token: host.token,
      },
    ],
  });
}

/** Restore a Game from a persisted snapshot, upgrading older versions. */
export function restoreGame(snapshot: unknown): GameCore {
  const version = (snapshot as { version?: unknown } | null)?.version;
  if (version !== SNAPSHOT_VERSION) {
    throw new GameError('unsupported_snapshot', `Cannot restore snapshot version ${String(version)}`);
  }
  return fromSnapshot(structuredClone(snapshot as GameSnapshot));
}

function fromSnapshot(state: GameSnapshot): GameCore {
  function lobbyView(): Game {
    return {
      id: state.gameId,
      roomCode: state.joinCode,
      status: state.status,
      createdAt: new Date(state.createdAt).toISOString(),
      players: state.seats.map(({ playerId, name, role, ready, isHost }) => ({
        id: playerId,
        name,
        role,
        ready,
        isHost,
      })),
    };
  }

  return {
    apply(command) {
      switch (command.type) {
        case 'seat_reconnected': {
          const seated = state.seats.some((s) => s.playerId === command.playerId);
          if (!seated) {
            return [{ type: 'close', seat: command.playerId, code: CLOSE_CODES.seatRejected }];
          }
          return [
            {
              type: 'send',
              to: { seat: command.playerId },
              message: { t: 'lobby_update', d: { game: lobbyView() } },
            },
          ];
        }
      }
    },

    lobby: lobbyView,

    seatFor(token) {
      return state.seats.find((s) => s.token === token)?.playerId;
    },

    snapshot() {
      return structuredClone(state);
    },
  };
}
