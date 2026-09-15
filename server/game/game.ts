/**
 * The game core: one instance per Game, from its creation through the Lobby.
 * Plain TypeScript with no platform imports — the host (`server/rooms/GameRoom.ts`)
 * feeds it commands with the current time and carries out the effects it returns.
 * Domain terms follow `server/CONTEXT.md`.
 */
import type { BoundaryCircle, Game, GameStatus, LobbyAck, OkAck, Role, ServerEventFrame } from '../../shared/index.ts';
import { CLOSE_CODES, validateSetBoundary, type CloseCode } from '../../shared/index.ts';

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
  /** Epoch ms at which a dropped Seat is released, unless it reconnects first. */
  graceDeadline?: number;
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
  boundary?: BoundaryCircle;
}

/** Who a message goes to. */
export type Audience = { seat: string } | { role: Role } | 'everyone';

/** A request a Seat sent over its socket; `payload` is still untrusted. */
interface SeatRequest<T extends string> {
  type: T;
  playerId: string;
  requestId: number;
  payload: unknown;
}

export type Command =
  | { type: 'join'; playerId: string; name: unknown; token: string }
  | SeatRequest<'set_role' | 'set_ready' | 'set_boundary' | 'leave_game'>
  | { type: 'seat_dropped'; playerId: string }
  | { type: 'seat_reconnected'; playerId: string }
  | { type: 'timers_due' };

/** The body of a reply: today's `LobbyAck` / `OkAck` shapes. */
export type ReplyBody = LobbyAck | OkAck;

export type Effect =
  | { type: 'send'; to: Audience; message: ServerEventFrame }
  | { type: 'reply'; requestId: number; body: ReplyBody }
  | { type: 'close'; seat: string; code: CloseCode }
  | { type: 'durableChanged' };

export type GameErrorCode =
  | 'name_required'
  | 'already_started'
  | 'player_not_found'
  | 'not_host'
  | 'invalid_role'
  | 'invalid_payload'
  | 'unsupported_snapshot';

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
  /** The earliest deadline (epoch ms) at which `timers_due` must be applied, if any. */
  nextDeadline(): number | null;
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

/** How long a dropped Seat is held by default. */
export const DEFAULT_GRACE_MS = 30_000;

/** Rules the host passes in; each has a default. */
export interface GameConfig {
  /** The Grace period in milliseconds. */
  graceMs?: number;
}

/** An error reply to a Seat's request. */
function rejected(requestId: number, code: string, error: string): Effect[] {
  return [{ type: 'reply', requestId, body: { ok: false, error, code } }];
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new GameError('name_required', 'A name is required');
  return name.slice(0, MAX_NAME_LENGTH);
}

/** Create a Game in its Lobby, with the Host as a Hunter who is not ready. */
export function createGame(host: NewHost, setup: GameSetup, config: GameConfig = {}): GameCore {
  return fromSnapshot(config, {
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
export function restoreGame(snapshot: unknown, config: GameConfig = {}): GameCore {
  const version = (snapshot as { version?: unknown } | null)?.version;
  if (version !== SNAPSHOT_VERSION) {
    throw new GameError('unsupported_snapshot', `Cannot restore snapshot version ${String(version)}`);
  }
  return fromSnapshot(config, structuredClone(snapshot as GameSnapshot));
}

function fromSnapshot({ graceMs = DEFAULT_GRACE_MS }: GameConfig, state: GameSnapshot): GameCore {
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
      ...(state.boundary ? { boundary: state.boundary } : {}),
    };
  }

  function lobbyUpdate(): ServerEventFrame {
    return { t: 'lobby_update', d: { game: lobbyView() } };
  }

  function requireLobby(): void {
    if (state.status !== 'lobby') throw new GameError('already_started', 'The Game has already started');
  }

  function requireSeat(playerId: string): SeatSnapshot {
    const seat = state.seats.find((s) => s.playerId === playerId);
    if (!seat) throw new GameError('player_not_found', 'You are not in this Game');
    return seat;
  }

  /** Remove a Seat, handing the Host role to the next player if needed. */
  function releaseSeat(playerId: string): void {
    const wasHost = state.seats.find((s) => s.playerId === playerId)?.isHost;
    state.seats = state.seats.filter((s) => s.playerId !== playerId);
    if (wasHost && state.seats[0]) state.seats[0].isHost = true;
  }

  /**
   * Run a Seat's request: a rejection becomes an error reply; a change is
   * persisted, answered (with the Lobby unless `reply` says otherwise) and
   * broadcast to everyone.
   */
  function seatRequest(
    command: SeatRequest<string>,
    change: (seat: SeatSnapshot) => void,
    reply: () => ReplyBody = () => ({ ok: true, game: lobbyView(), playerId: command.playerId }),
  ): Effect[] {
    try {
      change(requireSeat(command.playerId));
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
      return rejected(command.requestId, error.code, error.message);
    }
    return [
      { type: 'durableChanged' },
      { type: 'reply', requestId: command.requestId, body: reply() },
      { type: 'send', to: 'everyone', message: lobbyUpdate() },
    ];
  }

  function payloadField(payload: unknown, key: string): unknown {
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
  }

  return {
    apply(command, now) {
      switch (command.type) {
        case 'seat_dropped': {
          const seat = state.seats.find((s) => s.playerId === command.playerId);
          if (!seat) return [];
          seat.graceDeadline = now + graceMs;
          return [{ type: 'durableChanged' }];
        }
        case 'timers_due': {
          const released = state.seats.filter((s) => s.graceDeadline !== undefined && s.graceDeadline <= now);
          if (released.length === 0) return [];
          for (const seat of released) releaseSeat(seat.playerId);
          return [
            { type: 'durableChanged' },
            { type: 'send', to: 'everyone', message: lobbyUpdate() },
            ...released.map((seat): Effect => ({ type: 'close', seat: seat.playerId, code: CLOSE_CODES.seatRejected })),
          ];
        }
        case 'set_role':
          return seatRequest(command, (seat) => {
            const role = payloadField(command.payload, 'role');
            if (role !== 'hunter' && role !== 'hider') throw new GameError('invalid_role', 'Unknown role');
            requireLobby();
            seat.role = role;
          });
        case 'set_ready':
          return seatRequest(command, (seat) => {
            const ready = payloadField(command.payload, 'ready');
            if (typeof ready !== 'boolean') throw new GameError('invalid_payload', 'ready must be true or false');
            requireLobby();
            seat.ready = ready;
          });
        case 'set_boundary': {
          const result = validateSetBoundary(command.payload);
          if (!result.ok) {
            return rejected(command.requestId, result.code, result.error);
          }
          return seatRequest(command, (seat) => {
            if (!seat.isHost) throw new GameError('not_host', 'Only the Host can set the Boundary');
            state.boundary = result.value.boundary;
          });
        }
        case 'leave_game': {
          const effects = seatRequest(command, (seat) => releaseSeat(seat.playerId), () => ({ ok: true }));
          // Only a Seat that actually left is closed.
          if (!effects.some((effect) => effect.type === 'durableChanged')) return effects;
          return [...effects, { type: 'close', seat: command.playerId, code: CLOSE_CODES.seatRejected }];
        }
        case 'join': {
          requireLobby();
          state.seats.push({
            playerId: command.playerId,
            name: cleanName(command.name),
            role: 'hider',
            ready: false,
            isHost: false,
            token: command.token,
          });
          return [{ type: 'durableChanged' }, { type: 'send', to: 'everyone', message: lobbyUpdate() }];
        }
        case 'seat_reconnected': {
          const seat = state.seats.find((s) => s.playerId === command.playerId);
          if (!seat) {
            return [{ type: 'close', seat: command.playerId, code: CLOSE_CODES.seatRejected }];
          }
          const held = seat.graceDeadline !== undefined;
          delete seat.graceDeadline;
          return [
            ...(held ? [{ type: 'durableChanged' } as const] : []),
            {
              type: 'send',
              to: { seat: command.playerId },
              message: { t: 'lobby_update', d: { game: lobbyView() } },
            },
          ];
        }
      }
    },

    nextDeadline() {
      const deadlines = state.seats.flatMap((s) => (s.graceDeadline === undefined ? [] : [s.graceDeadline]));
      return deadlines.length > 0 ? Math.min(...deadlines) : null;
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
