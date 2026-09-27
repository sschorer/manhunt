/**
 * The game core: one instance per Game, from its creation through the Lobby and
 * play. Plain TypeScript with no platform imports — the host (`server/rooms/GameRoom.ts`)
 * feeds it commands with the current time and carries out the effects it returns.
 * Domain terms follow `server/CONTEXT.md`.
 */
import type {
  BoundaryCircle,
  CatchAck,
  CatchConfirmedEvent,
  CatchRecord,
  EndReason,
  Game,
  GameRules,
  GameStatus,
  GameSummary,
  LobbyAck,
  OkAck,
  Position,
  PositionsByPlayer,
  Role,
  ServerEventFrame,
} from '../../shared/index.ts';
import {
  CLOSE_CODES,
  validateClaimCatch,
  validatePositionUpdate,
  validateSetBoundary,
  type CloseCode,
} from '../../shared/index.ts';
import { DEFAULT_BOUNDARY_WARNINGS, metersOutside } from '../live/boundary.ts';
import { DEFAULT_CATCH_RADIUS_M } from '../live/catch.ts';
import { haversineMeters, MAX_PLAUSIBLE_SPEED_MPS } from '../live/tick.ts';
import { buildSummary } from './summary.ts';

/** Longest accepted player name, to keep the roster tidy and bound payloads. */
export const MAX_NAME_LENGTH = 24;

/** The version of {@link GameSnapshot}; raised when its shape changes. */
export const SNAPSHOT_VERSION = 1;

/**
 * How recent both fixes must be for a Catch to be decided from them, in
 * milliseconds. A Catch is measured from the Game's own positions, which are
 * only as current as the last `position_update` — a player reports at most every
 * 10 seconds, and stops reporting altogether while their signal is gone. Three
 * cadences of slack keeps an honest claim working over a patchy fix, while a
 * Hunter who lost sight of a Hider minutes ago cannot catch where they were.
 */
export const MAX_CATCH_FIX_AGE_MS = 30_000;

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
  /** Warnings issued on the Seat's current excursion outside the Boundary. */
  boundaryWarnings?: number;
  /** Epoch ms at which the player was eliminated for staying outside the Boundary. */
  eliminatedAt?: number;
}

/** Everything a Game needs to be restored after its host is evicted. Never holds positions. */
export interface GameSnapshot {
  version: typeof SNAPSHOT_VERSION;
  gameId: string;
  joinCode: string;
  status: GameStatus;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch ms at which the Host started the Game. */
  startedAt?: number;
  seats: SeatSnapshot[];
  boundary?: BoundaryCircle;
  /**
   * Every Catch the Game confirmed, in the order it confirmed them. A Catch
   * turns its Hider into a Hunter, so who started as a Hider is the Hiders left
   * on the roster plus every `targetId` here.
   */
  catches?: CatchRecord[];
  /**
   * Epoch ms of the next Ping reveal, set while the Game runs. It keeps the
   * cadence the Game started on, so the reveal a client counts down to is the
   * one the Game fires — and it survives an eviction, because it is right here.
   */
  pingDeadline?: number;
  /** Epoch ms at which the Game ended; its storage is deleted {@link RETENTION_MS} later. */
  endedAt?: number;
  /** The summary `game_over` carried, handed again to anyone who connects after the end. */
  summary?: GameSummary;
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
  | SeatRequest<'set_role' | 'set_ready' | 'set_boundary' | 'start_game' | 'leave_game' | 'claim_catch'>
  | { type: 'position_update'; playerId: string; payload: unknown }
  | { type: 'seat_dropped'; playerId: string }
  | { type: 'seat_reconnected'; playerId: string }
  | { type: 'timers_due' };

/** The body of a reply: today's `LobbyAck` / `CatchAck` / `OkAck` shapes. */
export type ReplyBody = LobbyAck | CatchAck | OkAck;

export type Effect =
  | { type: 'send'; to: Audience; message: ServerEventFrame }
  | { type: 'reply'; requestId: number; body: ReplyBody }
  | { type: 'close'; seat: string; code: CloseCode }
  | { type: 'durableChanged' }
  /** An accepted position, for the host to keep outside storage (on the Seat's socket). */
  | { type: 'positionChanged'; seat: string; position: Position }
  /**
   * The Game is gone: the host deletes all of its storage, which frees its Join
   * code. Always the last effect; the core must not be used after it.
   */
  | { type: 'deleted' };

export type GameErrorCode =
  | 'name_required'
  | 'already_started'
  | 'player_not_found'
  | 'not_host'
  | 'not_ready'
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
  /**
   * The earliest deadline (epoch ms) at which `timers_due` must be applied. There
   * always is one: every Game is deleted by its retention deadline at the latest.
   */
  nextDeadline(): number;
  /** The Lobby as players see it: no Seat tokens. */
  lobby(): Game;
  /** Where the Game stands, for a host that has to react to it changing. */
  status(): GameStatus;
  /** The latest accepted position of every seated player. Kept in memory only. */
  positions(): PositionsByPlayer;
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

/** How often a Ping reveal happens by default. */
export const DEFAULT_PING_INTERVAL_MS = 180_000;

/** How long a Game runs by default. */
export const DEFAULT_GAME_DURATION_MS = 1_800_000;

/**
 * How long a Game's storage is kept: from its end, or from its creation for a
 * Game that never ends. Nothing about a Game outlives it.
 */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Players a Game needs before it can start. */
export const MIN_PLAYERS_TO_START = 2;

/** Rules the host passes in; each has a default. */
export interface GameConfig {
  /** The Grace period in milliseconds. */
  graceMs?: number;
  /** Milliseconds between Ping reveals. */
  pingIntervalMs?: number;
  /** How long a Game runs, in milliseconds. */
  gameDurationMs?: number;
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

/**
 * Whether moving from `previous` to `next` means going faster than anyone
 * plausibly can. Two fixes without a measurable interval between them pass.
 */
function isImplausibleJump(previous: Position, next: Position): boolean {
  const elapsedMs = Date.parse(next.recordedAt) - Date.parse(previous.recordedAt);
  if (elapsedMs <= 0) return false;
  return haversineMeters(previous, next) / (elapsedMs / 1000) > MAX_PLAUSIBLE_SPEED_MPS;
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

/**
 * Restore a Game from a persisted snapshot, upgrading older versions. Positions
 * are not in the snapshot; the host hands back the ones it kept, if any.
 */
export function restoreGame(
  snapshot: unknown,
  config: GameConfig = {},
  positions: PositionsByPlayer = {},
): GameCore {
  const version = (snapshot as { version?: unknown } | null)?.version;
  if (version !== SNAPSHOT_VERSION) {
    throw new GameError('unsupported_snapshot', `Cannot restore snapshot version ${String(version)}`);
  }
  return fromSnapshot(config, structuredClone(snapshot as GameSnapshot), positions);
}

function fromSnapshot(
  {
    graceMs = DEFAULT_GRACE_MS,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    gameDurationMs = DEFAULT_GAME_DURATION_MS,
  }: GameConfig,
  state: GameSnapshot,
  restoredPositions: PositionsByPlayer = {},
): GameCore {
  const rules: GameRules = { pingIntervalMs, gameDurationMs };
  /** Seated and not eliminated: only these players report and are reported. */
  const isInPlay = (playerId: string) =>
    state.seats.some((s) => s.playerId === playerId && s.eliminatedAt === undefined);
  const positions = new Map(Object.entries(restoredPositions).filter(([playerId]) => isInPlay(playerId)));

  function lobbyView(): Game {
    return {
      id: state.gameId,
      roomCode: state.joinCode,
      status: state.status,
      createdAt: new Date(state.createdAt).toISOString(),
      ...(state.startedAt === undefined ? {} : { startedAt: new Date(state.startedAt).toISOString() }),
      players: state.seats.map(({ playerId, name, role, ready, isHost, eliminatedAt }) => ({
        id: playerId,
        name,
        role,
        ready,
        isHost,
        ...(eliminatedAt === undefined ? {} : { eliminated: true }),
      })),
      ...(state.boundary ? { boundary: state.boundary } : {}),
      rules,
    };
  }

  function lobbyUpdate(): ServerEventFrame {
    return { t: 'lobby_update', d: { game: lobbyView() } };
  }

  /** The live positions one side may see: Hunters only ever see Hunters. */
  function gameState(role: Role): ServerEventFrame {
    const visible: PositionsByPlayer = {};
    for (const seat of state.seats) {
      const position = positions.get(seat.playerId);
      if (position && (role === 'hider' || seat.role === 'hunter')) visible[seat.playerId] = position;
    }
    return { t: 'game_state', d: { gameId: state.gameId, positions: visible } };
  }

  /**
   * What a Ping reveal shows: every position the Game holds, with the role filter
   * lifted, so for this one broadcast the Hunters are shown the Hiders too. Both
   * sides get the same view, flagged `reveal` — which is how a client tells it
   * from an ordinary broadcast and can say a Hider was seen.
   */
  function pingRevealState(): ServerEventFrame {
    return {
      t: 'game_state',
      d: { gameId: state.gameId, positions: Object.fromEntries(positions), reveal: true },
    };
  }

  function requireLobby(): void {
    if (state.status !== 'lobby') throw new GameError('already_started', 'The Game has already started');
  }

  /** The Seat of a player who is on `role` and still in play, if that is who they are. */
  function seatInPlayAs(playerId: string, role: Role): SeatSnapshot | undefined {
    const seat = state.seats.find((s) => s.playerId === playerId);
    return seat?.role === role && seat.eliminatedAt === undefined ? seat : undefined;
  }

  /** Whether a fix is too old to decide a Catch from (see {@link MAX_CATCH_FIX_AGE_MS}). */
  function isStale(position: Position, now: number): boolean {
    return now - Date.parse(position.recordedAt) > MAX_CATCH_FIX_AGE_MS;
  }

  function requireSeat(playerId: string): SeatSnapshot {
    const seat = state.seats.find((s) => s.playerId === playerId);
    if (!seat) throw new GameError('player_not_found', 'You are not in this Game');
    return seat;
  }

  /** Enough players, all ready, with both a Hunter and a Hider. */
  function canStart(): boolean {
    return (
      state.seats.length >= MIN_PLAYERS_TO_START &&
      state.seats.every((s) => s.ready) &&
      state.seats.some((s) => s.role === 'hunter') &&
      state.seats.some((s) => s.role === 'hider')
    );
  }

  /** Remove a Seat, handing the Host role to the next player if needed. */
  function releaseSeat(playerId: string): void {
    const wasHost = state.seats.find((s) => s.playerId === playerId)?.isHost;
    state.seats = state.seats.filter((s) => s.playerId !== playerId);
    positions.delete(playerId);
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

  /**
   * Check one accepted fix against the Boundary. A player outside it is warned,
   * personally; staying out once their warnings are used up is an Elimination,
   * which everyone is told about. Only the fix that changes a player's standing
   * produces effects, so staying put is silent.
   */
  function enforceBoundary(
    seat: SeatSnapshot,
    position: Position,
    now: number,
  ): { effects: Effect[]; eliminated: boolean } {
    if (!state.boundary) return { effects: [], eliminated: false };
    const outside = metersOutside(state.boundary, position);
    // Back inside: the excursion is over and its warnings are forgiven.
    if (outside === 0) {
      if (seat.boundaryWarnings === undefined) return { effects: [], eliminated: false };
      delete seat.boundaryWarnings;
      return { effects: [{ type: 'durableChanged' }], eliminated: false };
    }
    const warnings = (seat.boundaryWarnings ?? 0) + 1;
    seat.boundaryWarnings = warnings;
    const at = new Date(now).toISOString();
    if (warnings > DEFAULT_BOUNDARY_WARNINGS) {
      seat.eliminatedAt = now;
      // Out of play: their last position goes with them, so nobody is shown it again.
      positions.delete(seat.playerId);
      return {
        eliminated: true,
        effects: [
          { type: 'durableChanged' },
          {
            type: 'send',
            to: 'everyone',
            message: {
              t: 'player_eliminated',
              d: { gameId: state.gameId, playerId: seat.playerId, reason: 'boundary', at },
            },
          },
          { type: 'send', to: 'everyone', message: lobbyUpdate() },
        ],
      };
    }
    return {
      eliminated: false,
      effects: [
        { type: 'durableChanged' },
        {
          type: 'send',
          to: { seat: seat.playerId },
          message: {
            t: 'boundary_warning',
            d: {
              gameId: state.gameId,
              playerId: seat.playerId,
              warnings,
              warningsRemaining: DEFAULT_BOUNDARY_WARNINGS - warnings,
              metersOutside: outside,
              at,
            },
          },
        },
      ],
    };
  }

  /**
   * The Seats whose Grace period has run out, released and closed. The Lobby goes
   * out once for all of them, because they all left at the same moment. Releasing
   * the last Seat deletes the Game; releasing the last Hider in a running Game ends it.
   */
  function seatsReleased(now: number): Effect[] {
    const released = state.seats.filter((s) => s.graceDeadline !== undefined && s.graceDeadline <= now);
    if (released.length === 0) return [];
    for (const seat of released) releaseSeat(seat.playerId);
    const closed = released.map((seat): Effect => ({ type: 'close', seat: seat.playerId, code: CLOSE_CODES.seatRejected }));
    // Nobody is left to play: the Game goes, whatever phase it was in.
    if (state.seats.length === 0) return [...closed, { type: 'deleted' }];
    return [
      { type: 'durableChanged' },
      { type: 'send', to: 'everyone', message: lobbyUpdate() },
      ...closed,
      ...endIfNoHiderLeft(now),
    ];
  }

  /**
   * The Ping reveal, once its deadline has passed. The deadline then moves on to
   * the next moment of the Game's own cadence — the one clients count down to from
   * `startedAt` — skipping any reveal the Game slept through, so a Game that wakes
   * up late reveals once instead of catching up on all of them. With no Hider
   * position to disclose there is nothing to reveal, and nothing is sent.
   */
  function pingRevealIfDue(now: number): Effect[] {
    const due = state.pingDeadline;
    if (due === undefined || due > now) return [];
    // A Game that is over reveals nothing, and gives the alarm nothing to wake for.
    if (state.status !== 'active') {
      delete state.pingDeadline;
      return [{ type: 'durableChanged' }];
    }
    const steps = Math.floor((now - due) / pingIntervalMs) + 1;
    state.pingDeadline = due + steps * pingIntervalMs;
    if (!state.seats.some((s) => s.role === 'hider' && positions.has(s.playerId))) {
      return [{ type: 'durableChanged' }];
    }
    return [{ type: 'durableChanged' }, { type: 'send', to: 'everyone', message: pingRevealState() }];
  }

  function gameOver(summary: GameSummary): ServerEventFrame {
    return { t: 'game_over', d: { gameId: state.gameId, summary } };
  }

  /** Every Seat's socket closed with `code`. */
  function closeAll(code: CloseCode): Effect[] {
    return state.seats.map((seat): Effect => ({ type: 'close', seat: seat.playerId, code }));
  }

  /**
   * End the Game at `endedAt` and tell everyone how it went: `game_over` with the
   * summary, then every socket closed with `4002`. The summary is kept in the
   * snapshot, and so is every Seat — a dropped socket no longer starts a Grace
   * period — so whoever connects later is handed the same summary until the Game
   * is deleted.
   *
   * The Hiders on the summary are the Game's original Hiders who are still seated
   * and were not eliminated: those still hiding and those who were caught. A
   * player who left, or was eliminated for leaving the Boundary, is out of play
   * and earns no survival time.
   */
  function endGame(reason: EndReason, endedAt: number): Effect[] {
    const caught = new Set((state.catches ?? []).map((c) => c.targetId));
    const summary = buildSummary({
      gameId: state.gameId,
      startedAt: new Date(state.startedAt ?? endedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      reason,
      initialHiders: state.seats
        .filter((s) => caught.has(s.playerId) || (s.role === 'hider' && s.eliminatedAt === undefined))
        .map(({ playerId, name }) => ({ playerId, name })),
      catches: state.catches ?? [],
    });
    state.status = 'ended';
    state.endedAt = endedAt;
    state.summary = summary;
    delete state.pingDeadline;
    for (const seat of state.seats) delete seat.graceDeadline;
    return [
      { type: 'durableChanged' },
      { type: 'send', to: 'everyone', message: gameOver(summary) },
      ...closeAll(CLOSE_CODES.gameEnded),
    ];
  }

  /**
   * The Hunters' win: a running Game with no Hider left in play is over. The last
   * Hider is usually caught, but one eliminated or gone for good ends it as well —
   * nobody is left to find either way.
   */
  function endIfNoHiderLeft(now: number): Effect[] {
    const hiderLeft = state.seats.some((s) => s.role === 'hider' && s.eliminatedAt === undefined);
    return state.status === 'active' && !hiderLeft ? endGame('all_caught', now) : [];
  }

  /** Epoch ms at which a running Game runs out of time. */
  function timeUpAt(): number | undefined {
    return state.status === 'active' && state.startedAt !== undefined ? state.startedAt + gameDurationMs : undefined;
  }

  /**
   * The Hiders' win: the game length has elapsed with a Hider still free. The
   * Game ends at its deadline, not whenever the host woke up, so the summary
   * says the Hiders lasted exactly the game length.
   */
  function timeUpIfDue(now: number): Effect[] {
    const due = timeUpAt();
    return due !== undefined && due <= now ? endGame('timer', due) : [];
  }

  /** Epoch ms at which the Game is deleted: {@link RETENTION_MS} after it ended, or after it was created. */
  function deleteAt(): number {
    return (state.endedAt ?? state.createdAt) + RETENTION_MS;
  }

  function payloadField(payload: unknown, key: string): unknown {
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
  }

  return {
    apply(command, now) {
      switch (command.type) {
        case 'seat_dropped': {
          const seat = state.seats.find((s) => s.playerId === command.playerId);
          // An ended Game closed every socket itself and keeps its Seats until it is deleted.
          if (!seat || state.status === 'ended') return [];
          seat.graceDeadline = now + graceMs;
          return [{ type: 'durableChanged' }];
        }
        /**
         * Every deadline the Game has reached. Past its retention the Game is
         * deleted and nothing else matters. Otherwise Seats are released first,
         * then the game length is checked — before the reveal, so a Game that ends
         * on a reveal's deadline reveals nothing.
         */
        case 'timers_due': {
          if (deleteAt() <= now) return [...closeAll(CLOSE_CODES.seatRejected), { type: 'deleted' }];
          const released = seatsReleased(now);
          if (released.some((effect) => effect.type === 'deleted')) return released;
          return [...released, ...timeUpIfDue(now), ...pingRevealIfDue(now)];
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
        case 'start_game':
          return seatRequest(command, (seat) => {
            if (!seat.isHost) throw new GameError('not_host', 'Only the Host can start the Game');
            requireLobby();
            if (!canStart()) {
              throw new GameError(
                'not_ready',
                `Need at least ${MIN_PLAYERS_TO_START} players — a Hunter and a Hider — all ready`,
              );
            }
            state.status = 'active';
            state.startedAt = now;
            state.pingDeadline = now + pingIntervalMs;
          });
        case 'position_update': {
          const result = validatePositionUpdate(command.payload);
          // The Seat's socket says who moved; a payload naming anyone else is dropped.
          if (!result.ok || result.value.gameId !== state.gameId || result.value.playerId !== command.playerId) {
            return [];
          }
          if (state.status !== 'active') return [];
          const seat = state.seats.find((s) => s.playerId === command.playerId);
          // An eliminated player is out of play: nothing they report counts any more.
          if (!seat || seat.eliminatedAt !== undefined) return [];
          const position: Position = {
            lat: result.value.lat,
            lng: result.value.lng,
            recordedAt: new Date(now).toISOString(),
          };
          const previous = positions.get(command.playerId);
          if (previous && isImplausibleJump(previous, position)) return [];
          positions.set(command.playerId, position);
          // Before the broadcasts: an Elimination takes the position back out again.
          const fenced = enforceBoundary(seat, position, now);
          return [
            ...(fenced.eliminated
              ? []
              : [{ type: 'positionChanged', seat: command.playerId, position } as const]),
            ...fenced.effects,
            { type: 'send', to: { role: 'hunter' }, message: gameState('hunter') },
            { type: 'send', to: { role: 'hider' }, message: gameState('hider') },
            ...(fenced.eliminated ? endIfNoHiderLeft(now) : []),
          ];
        }
        /**
         * A Hunter claims a Catch. The Game decides it from its own positions —
         * never from anything the claimant says about where either of them is —
         * so a spoofed claim is rejected without changing a thing. A confirmed
         * Catch turns the Hider into a Hunter, which changes what each side may
         * see, so both views go out again with it.
         */
        case 'claim_catch': {
          const result = validateClaimCatch(command.payload);
          if (!result.ok) return rejected(command.requestId, result.code, result.error);
          const { gameId, hunterId, targetId } = result.value;
          // The socket says who is claiming; a payload naming another player or
          // another Game is a client that lost track of who and where it is.
          if (gameId !== state.gameId || hunterId !== command.playerId) {
            return rejected(command.requestId, 'invalid_payload', 'A claim names this Game and yourself');
          }
          if (state.status !== 'active') {
            return rejected(command.requestId, 'not_active', 'The Game is not running');
          }
          if (!seatInPlayAs(hunterId, 'hunter')) {
            return rejected(command.requestId, 'not_hunter', 'Only a Hunter in play can claim a Catch');
          }
          const target = seatInPlayAs(targetId, 'hider');
          if (!target) {
            return rejected(command.requestId, 'not_hider', 'That player is not a Hider in play');
          }
          const hunterAt = positions.get(hunterId);
          const targetAt = positions.get(targetId);
          if (!hunterAt || !targetAt) {
            return rejected(command.requestId, 'no_position', 'Nobody has reported a position to measure yet');
          }
          if (isStale(hunterAt, now) || isStale(targetAt, now)) {
            return rejected(command.requestId, 'stale_position', 'The last positions are too old to decide a Catch');
          }
          if (haversineMeters(hunterAt, targetAt) > DEFAULT_CATCH_RADIUS_M) {
            return rejected(
              command.requestId,
              'out_of_range',
              `You have to be within ${DEFAULT_CATCH_RADIUS_M} m of the Hider`,
            );
          }
          target.role = 'hunter';
          const at = new Date(now).toISOString();
          const confirmed: CatchConfirmedEvent = { gameId: state.gameId, hunterId, targetId, at };
          state.catches = [...(state.catches ?? []), { hunterId, targetId, at }];
          return [
            { type: 'durableChanged' },
            { type: 'reply', requestId: command.requestId, body: { ok: true, catch: confirmed } },
            { type: 'send', to: 'everyone', message: { t: 'catch_confirmed', d: confirmed } },
            { type: 'send', to: 'everyone', message: lobbyUpdate() },
            { type: 'send', to: { role: 'hunter' }, message: gameState('hunter') },
            { type: 'send', to: { role: 'hider' }, message: gameState('hider') },
            // After the broadcasts, so everyone sees the last Catch before the end.
            ...endIfNoHiderLeft(now),
          ];
        }
        case 'leave_game': {
          const effects = seatRequest(command, (seat) => releaseSeat(seat.playerId), () => ({ ok: true }));
          // Only a Seat that actually left is closed.
          if (!effects.some((effect) => effect.type === 'durableChanged')) return effects;
          return [
            ...effects,
            { type: 'close', seat: command.playerId, code: CLOSE_CODES.seatRejected },
            ...(state.seats.length === 0 ? [{ type: 'deleted' } as const] : endIfNoHiderLeft(now)),
          ];
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
        /**
         * A Seat is back on a new socket. Nothing it missed is replayed, so it
         * gets the whole picture instead: the Lobby, and — in a running Game —
         * the live view its own side may see. After the end it gets the summary.
         */
        case 'seat_reconnected': {
          const seat = state.seats.find((s) => s.playerId === command.playerId);
          if (!seat) {
            return [{ type: 'close', seat: command.playerId, code: CLOSE_CODES.seatRejected }];
          }
          // Too late to play: the summary again, then the close that says it is over.
          if (state.status === 'ended') {
            return [
              ...(state.summary
                ? [{ type: 'send', to: { seat: command.playerId }, message: gameOver(state.summary) } as const]
                : []),
              { type: 'close', seat: command.playerId, code: CLOSE_CODES.gameEnded },
            ];
          }
          const held = seat.graceDeadline !== undefined;
          delete seat.graceDeadline;
          return [
            ...(held ? [{ type: 'durableChanged' } as const] : []),
            { type: 'send', to: { seat: command.playerId }, message: lobbyUpdate() },
            ...(state.status === 'active'
              ? [{ type: 'send', to: { seat: command.playerId }, message: gameState(seat.role) } as const]
              : []),
          ];
        }
      }
    },

    nextDeadline() {
      const deadlines = [
        ...state.seats.flatMap((s) => (s.graceDeadline === undefined ? [] : [s.graceDeadline])),
        ...(state.pingDeadline === undefined ? [] : [state.pingDeadline]),
        timeUpAt() ?? Infinity,
        deleteAt(),
      ];
      return Math.min(...deadlines);
    },

    lobby: lobbyView,

    status() {
      return state.status;
    },

    positions() {
      return Object.fromEntries(positions);
    },

    seatFor(token) {
      return state.seats.find((s) => s.token === token)?.playerId;
    },

    snapshot() {
      return structuredClone(state);
    },
  };
}
