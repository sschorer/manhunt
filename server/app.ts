import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { Server, type Socket } from 'socket.io';
import {
  createBoundaryMonitor,
  createLiveState,
  createPingScheduler,
  createTickEngine,
  evaluateCatch,
  DEFAULT_CATCH_RADIUS_M,
  DEFAULT_PING_INTERVAL_MS,
  type BoundaryMonitor,
  type CatchRejectReason,
  type LiveState,
  type PingScheduler,
  type PingTimerApi,
  type PlayerRole,
  type PositionsByPlayer,
  type GameStateMessage,
  type TickEngine,
} from './live/index.ts';
import {
  createMemoryLobby,
  LobbyError,
  type Game,
  type LobbyManager,
  type Role,
} from './lobby/rooms.ts';
import {
  validateClaimCatch,
  validateJoin,
  validatePositionUpdate,
  validateSetBoundary,
  type BoundaryWarningEvent,
  type CatchConfirmedEvent,
  type GameStateEvent,
  type LobbyUpdateEvent,
  type PlayerEliminatedEvent,
} from './protocol/messages.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Pick the directory of static assets to serve.
 *
 * In production the Vite client is built into `dist/` (see `npm run build` and
 * the Dockerfile). Before the client is built — or in a bare dev checkout — we
 * fall back to the static design preview in `public/`.
 */
function resolveStaticDir(): string {
  if (process.env.STATIC_DIR) return process.env.STATIC_DIR;
  const dist = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  return path.join(__dirname, '..', 'public');
}

export interface CreateServerOptions {
  staticDir?: string;
  /**
   * The live (hot) state layer. Defaults to {@link createLiveState}, which uses
   * Redis when `REDIS_URL` is set and an in-process fallback otherwise. Tests
   * inject an explicit in-memory layer for determinism.
   */
  liveState?: LiveState;
  /**
   * The lobby (room lifecycle) manager. Defaults to an in-process manager; tests
   * inject one so they can assert on room state directly.
   */
  lobby?: LobbyManager;
  /**
   * The authoritative tick engine. Defaults to one built over `liveState.store`;
   * tests inject one (e.g. with a deterministic clock) for reproducible
   * plausibility behavior.
   */
  tickEngine?: TickEngine;
  /**
   * The boundary (geofence) monitor that warns then eliminates players who leave
   * the play area. Defaults to one with the standard warning policy; tests inject
   * one (e.g. with `warningsBeforeElimination: 0`) for deterministic enforcement.
   */
  boundaryMonitor?: BoundaryMonitor;
  /**
   * Catch radius in metres: how close a hunter must be to a hider for a
   * `claim_catch` to succeed. Defaults to {@link DEFAULT_CATCH_RADIUS_M}; tests
   * set it explicitly to make the distance check deterministic. Tunable per game
   * once game settings land (BACKLOG.md #27).
   */
  catchRadiusM?: number;
  /**
   * Reveal interval in milliseconds for the ping-reveal scheduler (BACKLOG.md
   * #13). Defaults to {@link resolvePingIntervalMs} (from `PING_INTERVAL_S`).
   */
  pingIntervalMs?: number;
  /**
   * Timer primitives backing the ping-reveal scheduler. Defaults to the global
   * timers; tests inject a controllable fake so they can fire a reveal tick on
   * demand and assert the resulting broadcast, without leaning on wall-clock time.
   */
  pingTimers?: PingTimerApi;
}

export interface ServerHandle {
  app: Express;
  httpServer: http.Server;
  io: Server;
  liveState: LiveState;
  lobby: LobbyManager;
  /** The authoritative tick engine; `tickEngine.latest(gameId)` is the rules-engine read model. */
  tickEngine: TickEngine;
  /** The boundary geofence monitor (warn → eliminate) applied on every accepted tick. */
  boundaryMonitor: BoundaryMonitor;
  /** The ping-reveal scheduler; running per active game, stopped on teardown. */
  pingScheduler: PingScheduler;
}

/** Socket.IO room a game's broadcasts are emitted to. */
function gameRoom(gameId: string): string {
  return `game:${gameId}`;
}

/**
 * Filter a game's positions for a single recipient. Fails closed: a hunter only
 * ever sees positions explicitly marked `hunter`, so anything unlabelled (a
 * hider, or a record whose role we couldn't resolve) is withheld rather than
 * leaked. A hider (or a recipient whose own role is unknown) sees the full set.
 * The stored `role` marker is stripped so the roster isn't leaked to clients.
 *
 * `reveal` is the scheduled ping-reveal exception (BACKLOG.md #13/#14): on a
 * reveal tick the per-role filter is lifted, so a hunter receives every position
 * — including the hiders' — for that one broadcast.
 */
function visibleTo(
  recipientRole: PlayerRole | undefined,
  positions: PositionsByPlayer,
  reveal = false,
): PositionsByPlayer {
  const out: PositionsByPlayer = {};
  for (const [playerId, pos] of Object.entries(positions)) {
    if (!reveal && recipientRole === 'hunter' && pos.role !== 'hunter') continue;
    out[playerId] = { lat: pos.lat, lng: pos.lng, recordedAt: pos.recordedAt };
  }
  return out;
}

/**
 * Resolve Express's `trust proxy` setting from `TRUST_PROXY`.
 *
 * In production the app runs behind Caddy (see `Caddyfile`), which terminates
 * TLS and forwards `X-Forwarded-{For,Proto,Host}`. Trusting the proxy makes
 * `req.secure`, `req.protocol` and `req.ip` reflect the real client and the
 * HTTPS scheme — needed for secure cookies and correct client addresses.
 *
 * Defaults to `1` (trust the single Caddy hop). `TRUST_PROXY` overrides it:
 * `false`/`0` disables trust, a number sets the hop count, and any other value
 * (e.g. `loopback`, a subnet, or a comma list) is passed through to Express.
 */
export function resolveTrustProxy(
  raw: string | undefined = process.env.TRUST_PROXY,
): boolean | number | string {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) return n;
  return value;
}

/**
 * Resolve the ping-reveal interval (ms) from `PING_INTERVAL_S` (seconds — the
 * name and unit the deploy config and `db/schema.sql` use). Falls back to
 * {@link DEFAULT_PING_INTERVAL_MS} when unset, empty, or not a positive number,
 * so a missing or garbled env can never yield a zero/negative reveal timer.
 * Per-game override is a later concern (BACKLOG.md #27).
 */
export function resolvePingIntervalMs(
  raw: string | undefined = process.env.PING_INTERVAL_S,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PING_INTERVAL_MS;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_PING_INTERVAL_MS;
  return Math.trunc(seconds * 1000);
}

/** What we remember about a socket that has created or joined a lobby. */
interface LobbyMembership {
  gameId: string;
  playerId: string;
}

/** Ack shape for lobby actions: the current game on success, an error code otherwise. */
type LobbyAck =
  | { ok: true; game: Game; playerId: string }
  | { ok: false; error: string; code?: string };

/** Ack shape for `claim_catch`: the confirmed catch on success, an error otherwise. */
type CatchAck =
  | { ok: true; catch: CatchConfirmedEvent }
  | { ok: false; error: string; code?: string };

/** Read the membership a `create_game`/`join_game` recorded on the socket. */
function membershipOf(socket: Socket): LobbyMembership | undefined {
  return (socket.data as { lobby?: LobbyMembership }).lobby;
}

/** A rules-engine catch rejection as a client-facing ack error (code + message). */
function catchRejection(reason: CatchRejectReason): { ok: false; error: string; code: string } {
  const messages: Record<CatchRejectReason, string> = {
    not_hunter: 'Only a hunter can claim a catch',
    not_hider: 'That player is not a hider',
    no_position: 'No reported position to verify the catch',
    out_of_range: 'The target is out of catch range',
  };
  return { ok: false, error: messages[reason], code: reason };
}

/** Run a lobby action, translating a {@link LobbyError} into an ack error. */
function withLobbyErrors(
  ack: ((res: LobbyAck) => void) | undefined,
  run: () => void,
): void {
  try {
    run();
  } catch (err) {
    if (err instanceof LobbyError) {
      ack?.({ ok: false, error: err.message, code: err.code });
      return;
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error('lobby action failed:', reason);
    ack?.({ ok: false, error: 'Something went wrong' });
  }
}

/**
 * Build the Express app + HTTP server + Socket.IO instance without starting to
 * listen. Kept separate from `index.ts` so tests can drive it on an ephemeral
 * port and tear it down cleanly.
 */
export function createServer({
  staticDir = resolveStaticDir(),
  liveState = createLiveState(),
  lobby = createMemoryLobby(),
  tickEngine: tickEngineOption,
  boundaryMonitor = createBoundaryMonitor(),
  catchRadiusM = DEFAULT_CATCH_RADIUS_M,
  pingIntervalMs = resolvePingIntervalMs(),
  pingTimers,
}: CreateServerOptions = {}): ServerHandle {
  const app = express();

  // Behind the Caddy reverse proxy: trust its forwarded headers so req.secure
  // (HTTPS), req.protocol and req.ip are accurate. See resolveTrustProxy.
  app.set('trust proxy', resolveTrustProxy());

  // Liveness/readiness probe (used by the load balancer and Docker healthcheck).
  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

  app.use(express.static(staticDir));

  // SPA fallback: any other GET that isn't an API/health route serves the
  // client shell so client-side routing works on deep links and refreshes.
  const indexHtml = path.join(staticDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/health') || req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(indexHtml);
    });
  }

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const { store, broadcaster } = liveState;
  // The authoritative tick engine wraps the hot store: it ingests and validates
  // each position tick and exposes the latest snapshot to the rules engine.
  const tickEngine = tickEngineOption ?? createTickEngine(store);

  // The authoritative role of a player in a game, from the lobby roster (the
  // single source of truth for who is a hunter vs a hider). `undefined` when the
  // game or player isn't known — callers fail closed on that.
  const roleOf = (gameId: string, playerId: string | undefined): PlayerRole | undefined => {
    if (!playerId) return undefined;
    return lobby.get(gameId)?.players.find((p) => p.id === playerId)?.role;
  };

  // Fan-out path: a game-state message — published locally or received from
  // another instance over Redis pub/sub — is emitted to the game's sockets on
  // THIS instance, filtered per recipient's role (looked up from the lobby) so
  // hunters never receive hider coordinates (see BACKLOG.md #14). On a scheduled
  // ping reveal (`reveal`) the filter is lifted so hunters do get the hiders'
  // positions for that one broadcast (BACKLOG.md #13); the flag is echoed to
  // clients so they can surface the reveal.
  async function fanOut({ gameId, positions, reveal }: GameStateMessage): Promise<void> {
    const sockets = await io.in(gameRoom(gameId)).fetchSockets();
    for (const s of sockets) {
      const membership = (s.data as { lobby?: LobbyMembership }).lobby;
      const recipientRole = roleOf(gameId, membership?.playerId);
      const message: GameStateEvent = {
        gameId,
        positions: visibleTo(recipientRole, positions, reveal),
        ...(reveal ? { reveal: true } : {}),
      };
      s.emit('game_state', message);
    }
  }
  broadcaster.subscribe((message) => {
    void fanOut(message).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('game_state fan-out failed:', reason);
    });
  });

  // Ping-reveal scheduler: on the configured interval it forces a running game's
  // current positions into a reveal broadcast, so hunters get a periodic fix on
  // the hiders and can't just camp (BACKLOG.md #13, docs/arc42.md §6.4). A reveal
  // reads the tick engine's latest snapshot and publishes it with `reveal` set;
  // fan-out then lifts the per-role filter for that one message. Nothing to
  // disclose yet (no reported positions) is skipped rather than broadcasting an
  // empty reveal. The reveal rides the same broadcaster as ticks, so it fans out
  // across instances too.
  async function revealPing(gameId: string): Promise<void> {
    const positions = await tickEngine.latest(gameId);
    if (Object.keys(positions).length === 0) return;
    await broadcaster.publish({ gameId, positions, reveal: true });
  }
  const pingScheduler = createPingScheduler({
    intervalMs: pingIntervalMs,
    ...(pingTimers ? { timers: pingTimers } : {}),
    onReveal: (gameId) => {
      void revealPing(gameId).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('ping reveal failed:', reason);
      });
    },
  });

  // Push the current roster/status to everyone in a room after any change.
  const emitLobby = (game: Game): void => {
    const message: LobbyUpdateEvent = { game };
    io.to(gameRoom(game.id)).emit('lobby_update', message);
  };

  // Geofence one accepted fix against the game's play area. A warning is personal
  // — emitted only to the offending socket — while an elimination is broadcast to
  // the whole room so everyone (and later the win check, BACKLOG.md #15) learns a
  // player is out. Only the state-changing tick emits; steady state is silent.
  const enforceBoundary = (
    socket: Socket,
    membership: LobbyMembership,
    lat: number,
    lng: number,
  ): void => {
    const boundary = lobby.get(membership.gameId)?.boundary;
    if (!boundary) return;
    const verdict = boundaryMonitor.evaluate({
      gameId: membership.gameId,
      playerId: membership.playerId,
      position: { lat, lng },
      boundary,
    });
    if (!verdict.changed) return;
    const at = new Date().toISOString();
    if (verdict.status === 'warned') {
      const warning: BoundaryWarningEvent = {
        gameId: membership.gameId,
        playerId: membership.playerId,
        warnings: verdict.warnings,
        warningsRemaining: verdict.warningsRemaining,
        metersOutside: verdict.metersOutside,
        at,
      };
      socket.emit('boundary_warning', warning);
    } else if (verdict.status === 'eliminated') {
      const eliminated: PlayerEliminatedEvent = {
        gameId: membership.gameId,
        playerId: membership.playerId,
        reason: 'boundary',
        at,
      };
      io.to(gameRoom(membership.gameId)).emit('player_eliminated', eliminated);
    }
  };

  // Remove a socket from whatever lobby it currently holds: drop the player
  // server-side, leave the socket room, clear the membership, and broadcast the
  // updated roster if the room survives. A no-op when the socket isn't in a room.
  // Shared by leave_game, disconnect, and the create/join guard so a socket can
  // never linger in two rooms (which would leave a ghost player behind).
  const leaveCurrentLobby = (socket: Socket): void => {
    const membership = membershipOf(socket);
    if (!membership) return;
    const game = lobby.removePlayer(membership.gameId, membership.playerId);
    socket.leave(gameRoom(membership.gameId));
    delete (socket.data as { lobby?: LobbyMembership }).lobby;
    // Drop the departing player's geofence state so a mid-game leaver doesn't
    // leave a stale warn/eliminate entry parked for the game's lifetime; once the
    // room itself is gone, sweep whatever remains for the (recyclable) game id.
    boundaryMonitor.forget(membership.gameId, membership.playerId);
    if (!game) boundaryMonitor.forget(membership.gameId);
    // Once the room empties (the game is gone), stop its ping-reveal timer so no
    // scheduler outlives the game it reveals (BACKLOG.md #13).
    if (!game) pingScheduler.stop(membership.gameId);
    if (game) emitLobby(game);
  };

  // Authoritative game loop. The transport contract (join, position_update,
  // claim_catch → catch_confirmed) is wired here against `protocol/messages`;
  // position ticks run through the tick engine (validate → plausibility → store),
  // and game_state is filtered per role on fan-out. A `claim_catch` is verified
  // by the rules engine (catch-radius check + hider→hunter switch, BACKLOG.md #12).
  io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.id}`);

    // Subscribe a socket to a game's broadcasts. Acks so callers can await it.
    socket.on('join', (payload: unknown, ack?: (res: { ok: boolean }) => void) => {
      const result = validateJoin(payload);
      if (result.ok) socket.join(gameRoom(result.value.gameId));
      if (typeof ack === 'function') ack({ ok: result.ok });
    });

    // --- Lobby: create/join a room, pick a side, ready up, host starts. ---
    // Each socket owns at most one lobby membership, remembered in socket.data
    // so later actions (role/ready/start) don't need the client to echo ids.

    // Host a new room. Acks with the join code (via game.roomCode) and the
    // caller's player id, then subscribes the socket to the room.
    socket.on('create_game', (payload: unknown, ack?: (res: LobbyAck) => void) => {
      withLobbyErrors(ack, () => {
        // Never let one socket hold two rooms — drop any prior membership first
        // (double-submit, reconnect race, a client that didn't leave) so it can't
        // strand a ghost player in the old room.
        leaveCurrentLobby(socket);
        const { name } = (payload ?? {}) as { name?: unknown };
        const { game, player } = lobby.createGame(name);
        (socket.data as { lobby?: LobbyMembership }).lobby = {
          gameId: game.id,
          playerId: player.id,
        };
        socket.join(gameRoom(game.id));
        ack?.({ ok: true, game, playerId: player.id });
        emitLobby(game);
      });
    });

    // Join an existing room by its code as a hider.
    socket.on('join_game', (payload: unknown, ack?: (res: LobbyAck) => void) => {
      withLobbyErrors(ack, () => {
        // Drop any prior membership first (see create_game) so joining a room
        // never leaves a ghost behind in the one this socket was already in.
        leaveCurrentLobby(socket);
        const { roomCode, name } = (payload ?? {}) as { roomCode?: unknown; name?: unknown };
        const { game, player } = lobby.joinGame(roomCode, name);
        (socket.data as { lobby?: LobbyMembership }).lobby = {
          gameId: game.id,
          playerId: player.id,
        };
        socket.join(gameRoom(game.id));
        ack?.({ ok: true, game, playerId: player.id });
        emitLobby(game);
      });
    });

    // Switch the caller's own side (hunter/hider).
    socket.on('set_role', (payload: unknown, ack?: (res: LobbyAck) => void) => {
      withLobbyErrors(ack, () => {
        const membership = membershipOf(socket);
        if (!membership) throw new LobbyError('player_not_found', 'Not in a game');
        const { role } = (payload ?? {}) as { role?: unknown };
        if (role !== 'hunter' && role !== 'hider') {
          throw new LobbyError('player_not_found', 'Unknown role');
        }
        const game = lobby.setRole(membership.gameId, membership.playerId, role as Role);
        ack?.({ ok: true, game, playerId: membership.playerId });
        emitLobby(game);
      });
    });

    // Host-only: define (or replace) the play area the rules engine geofences
    // against. Identity is the socket's membership; the payload carries only the
    // boundary shape, validated to a WGS84 centre and a sane radius.
    socket.on('set_boundary', (payload: unknown, ack?: (res: LobbyAck) => void) => {
      const result = validateSetBoundary(payload);
      if (!result.ok) {
        ack?.({ ok: false, error: result.error, code: result.code });
        return;
      }
      withLobbyErrors(ack, () => {
        const membership = membershipOf(socket);
        if (!membership) throw new LobbyError('player_not_found', 'Not in a game');
        const game = lobby.setBoundary(
          membership.gameId,
          membership.playerId,
          result.value.boundary,
        );
        ack?.({ ok: true, game, playerId: membership.playerId });
        emitLobby(game);
      });
    });

    // Toggle the caller's ready flag.
    socket.on('set_ready', (payload: unknown, ack?: (res: LobbyAck) => void) => {
      withLobbyErrors(ack, () => {
        const membership = membershipOf(socket);
        if (!membership) throw new LobbyError('player_not_found', 'Not in a game');
        const { ready } = (payload ?? {}) as { ready?: unknown };
        const game = lobby.setReady(membership.gameId, membership.playerId, Boolean(ready));
        ack?.({ ok: true, game, playerId: membership.playerId });
        emitLobby(game);
      });
    });

    // Host-only: start the match once everyone is ready.
    socket.on('start_game', (_payload: unknown, ack?: (res: LobbyAck) => void) => {
      withLobbyErrors(ack, () => {
        const membership = membershipOf(socket);
        if (!membership) throw new LobbyError('player_not_found', 'Not in a game');
        const game = lobby.startGame(membership.gameId, membership.playerId);
        // The match is under way — begin periodic ping reveals for it (idempotent,
        // so a double start_game won't stack timers). BACKLOG.md #13.
        pingScheduler.start(game.id);
        ack?.({ ok: true, game, playerId: membership.playerId });
        emitLobby(game);
      });
    });

    // Leave the current room without disconnecting the socket. The server drops
    // the player and tells the rest of the room, mirroring disconnect cleanup.
    socket.on('leave_game', (_payload: unknown, ack?: (res: { ok: boolean }) => void) => {
      leaveCurrentLobby(socket);
      ack?.({ ok: true });
    });

    // One tick: a client reports its position. The tick engine validates the
    // payload, stamps the authoritative time, applies a plausibility guard, and
    // writes the accepted fix to the hot store; we then publish the game's live
    // positions for cross-instance fan-out. Malformed or implausible payloads are
    // dropped silently (this is a fire-and-forget event with no ack).
    socket.on('position_update', async (payload: unknown) => {
      const result = validatePositionUpdate(payload);
      if (!result.ok) return;
      // Identity is the socket's authoritative lobby membership, never the
      // payload — a client can't write another player's position. Drop the tick
      // if the socket isn't a game member, or if it claims a different identity.
      const membership = membershipOf(socket);
      if (!membership) return;
      const { gameId, playerId, lat, lng } = result.value;
      if (gameId !== membership.gameId || playerId !== membership.playerId) return;
      try {
        // Stamp the writer's role (from the lobby roster) so fan-out can filter
        // per recipient — hunters never receive hider coordinates (BACKLOG.md #14).
        const tick = await tickEngine.ingest({
          gameId: membership.gameId,
          playerId: membership.playerId,
          role: roleOf(membership.gameId, membership.playerId),
          lat,
          lng,
        });
        // An implausible jump (GPS spoof / teleport) is dropped without a write
        // or a broadcast, so the last good fix stands (BACKLOG.md #26).
        if (!tick.ok) return;
        await broadcaster.publish({ gameId: membership.gameId, positions: tick.positions });
        // Geofence the accepted fix against the game's play area (BACKLOG.md #11).
        // Leaving warns the player, then eliminates them once the warnings run
        // out — an authoritative, server-side decision. A game with no boundary
        // configured is simply unenforced.
        enforceBoundary(socket, membership, lat, lng);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('position_update failed:', reason);
      }
    });

    // A hunter claims to have caught a hider. The server is authoritative: it
    // verifies the catch server-side (BACKLOG.md #12, docs/arc42.md §6.2) — the
    // claimant is a hunter, the target an uncaught hider, and their latest
    // server-side positions are within the catch radius — before it does
    // anything. Only a verified claim flips the caught hider to a hunter,
    // broadcasts `catch_confirmed` and the updated roster, and acks success; an
    // out-of-range or otherwise invalid claim is rejected with no state change.
    socket.on('claim_catch', async (payload: unknown, ack?: (res: CatchAck) => void) => {
      const result = validateClaimCatch(payload);
      if (!result.ok) {
        ack?.({ ok: false, error: result.error, code: result.code });
        return;
      }
      const { gameId, hunterId, targetId } = result.value;
      // Identity is the socket's authoritative lobby membership, never the
      // payload: a client can only claim a catch as itself, in its own game.
      const membership = membershipOf(socket);
      if (!membership || membership.gameId !== gameId || membership.playerId !== hunterId) {
        ack?.(catchRejection('not_hunter'));
        return;
      }
      try {
        const positions = await tickEngine.latest(gameId);
        const decision = evaluateCatch({
          hunterRole: roleOf(gameId, hunterId),
          targetRole: roleOf(gameId, targetId),
          hunterPosition: positions[hunterId],
          targetPosition: positions[targetId],
          radiusM: catchRadiusM,
        });
        if (!decision.ok) {
          ack?.(catchRejection(decision.reason));
          return;
        }
        // Authoritative outcome: the caught hider becomes a hunter, and the
        // room learns of both the catch and the roster change.
        const game = lobby.catchPlayer(gameId, targetId);
        const confirmed: CatchConfirmedEvent = {
          gameId,
          hunterId,
          targetId,
          at: new Date().toISOString(),
        };
        io.to(gameRoom(gameId)).emit('catch_confirmed', confirmed);
        emitLobby(game);
        ack?.({ ok: true, catch: confirmed });
      } catch (err) {
        if (err instanceof LobbyError) {
          ack?.({ ok: false, error: err.message, code: err.code });
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        console.error('claim_catch failed:', reason);
        ack?.({ ok: false, error: 'Something went wrong' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${socket.id}`);
      // Drop the player from their lobby; if the room survives, tell the rest.
      leaveCurrentLobby(socket);
    });
  });

  return { app, httpServer, io, liveState, lobby, tickEngine, boundaryMonitor, pingScheduler };
}
