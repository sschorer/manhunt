import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  createOutcomeTracker,
  createPingScheduler,
  createTickEngine,
  evaluateCatch,
  DEFAULT_CATCH_RADIUS_M,
  DEFAULT_GAME_DURATION_MS,
  DEFAULT_PING_INTERVAL_MS,
  type BoundaryMonitor,
  type CatchRejectReason,
  type EndReason,
  type GameTimerApi,
  type LiveState,
  type OutcomeTracker,
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
  validatePushSubscription,
  validateResume,
  validateSetBoundary,
  type BoundaryWarningEvent,
  type CatchConfirmedEvent,
  type GameOverEvent,
  type GameStateEvent,
  type LobbyUpdateEvent,
  type PlayerEliminatedEvent,
} from './protocol/messages.ts';
import {
  createNotifier,
  createSubscriptionStore,
  createWebPushSender,
  resolveVapidConfig,
  type Notifier,
  type PushSender,
  type SubscriptionStore,
  type VapidConfig,
} from './push/index.ts';

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
  /**
   * Match duration in milliseconds for the survive-the-timer win condition
   * (BACKLOG.md #15): how long hiders must last for them to win. Defaults to
   * {@link resolveGameDurationMs} (from `GAME_DURATION_S`).
   */
  gameDurationMs?: number;
  /**
   * Timer primitives backing the survive-the-timer countdown. Defaults to the
   * global timers; tests inject a controllable fake so they can fire the timeout
   * on demand and assert the resulting `game_over`, without waiting out the clock.
   */
  gameTimers?: GameTimerApi;
  /**
   * VAPID configuration for Web Push (BACKLOG.md #23). Defaults to
   * {@link resolveVapidConfig} (from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`);
   * `undefined` — the default when no keys are set — disables Web Push: no public
   * key is advertised and nothing is pushed. Pass `null` to force it off even
   * when the env is configured (tests).
   */
  vapidConfig?: VapidConfig | null;
  /**
   * Reconnect grace period in milliseconds (BACKLOG.md #24): how long a player
   * who drops mid-match keeps their slot before the server removes them, so an
   * auto-reconnecting client can `resume` the same identity. Defaults to
   * {@link resolveDisconnectGraceMs} (from `DISCONNECT_GRACE_S`). `0` disables the
   * grace — a dropped socket is removed immediately. Tests set it explicitly.
   */
  disconnectGraceMs?: number;
  /**
   * Timer primitives backing the reconnect grace. Defaults to the global timers;
   * tests inject a controllable fake so they can fire the grace expiry on demand
   * and assert the resulting removal, without waiting out the clock.
   */
  disconnectTimers?: DisconnectTimerApi;
  /**
   * The push-subscription store, keyed by game then player. Defaults to an
   * in-process store; tests inject one to assert on the registered subscriptions.
   */
  subscriptions?: SubscriptionStore;
  /**
   * Delivers an encrypted push to a subscription. Defaults to a
   * `web-push`-backed sender when {@link vapidConfig} is set (a no-op otherwise);
   * tests inject a fake to assert what would be pushed, to whom, without a real
   * push service.
   */
  pushSender?: PushSender;
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
  /** The end-of-game tracker; the win-condition read model + survive timer per active game. */
  outcomeTracker: OutcomeTracker;
  /** The per-game Web Push subscription store (BACKLOG.md #23). */
  subscriptions: SubscriptionStore;
  /** The notifier that pushes key game events (caught, reveal, time) to subscribers. */
  notifier: Notifier;
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

/**
 * Resolve the match duration (ms) from `GAME_DURATION_S` (seconds — the name and
 * unit `db/schema.sql`'s `games.duration_s` column uses) for the
 * survive-the-timer win condition (BACKLOG.md #15). Falls back to
 * {@link DEFAULT_GAME_DURATION_MS} when unset, empty, or not a positive number, so
 * a missing or garbled env can never yield a zero/negative game timer. Per-game
 * override is a later concern (BACKLOG.md #27).
 */
export function resolveGameDurationMs(
  raw: string | undefined = process.env.GAME_DURATION_S,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_GAME_DURATION_MS;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_GAME_DURATION_MS;
  return Math.trunc(seconds * 1000);
}

/**
 * Default grace period, in milliseconds, before a player who dropped mid-match is
 * removed from their game (BACKLOG.md #24). A transient signal loss on a phone is
 * common, so the server holds the slot this long to let the auto-reconnecting
 * client `resume` the same identity instead of vanishing from the roster. Tunable
 * via `DISCONNECT_GRACE_S`.
 */
export const DEFAULT_DISCONNECT_GRACE_MS = 30_000;

/**
 * The subset of the timer API the disconnect-grace uses. `setTimeout` returns an
 * opaque handle stored per pending removal and later passed to `clearTimeout`
 * when the player resumes; the concrete type is hidden behind `unknown` so a fake
 * (or the global timers) can supply whatever handle it likes. Defaults to the
 * global timers, un-refed so a pending removal never keeps the process alive.
 */
export interface DisconnectTimerApi {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultDisconnectTimers: DisconnectTimerApi = {
  setTimeout: (handler, ms) => setTimeout(handler, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Resolve the reconnect grace period (ms) from `DISCONNECT_GRACE_S` (seconds).
 * Falls back to {@link DEFAULT_DISCONNECT_GRACE_MS} when unset, empty, or not a
 * finite non-negative number. `0` is honoured — it disables the grace, dropping a
 * player the instant their socket closes (the pre-#24 behaviour).
 */
export function resolveDisconnectGraceMs(
  raw: string | undefined = process.env.DISCONNECT_GRACE_S,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISCONNECT_GRACE_MS;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_DISCONNECT_GRACE_MS;
  return Math.trunc(seconds * 1000);
}

/** What we remember about a socket that has created or joined a lobby. */
interface LobbyMembership {
  gameId: string;
  playerId: string;
}

/**
 * Ack shape for lobby actions: the current game on success, an error code
 * otherwise. `create_game`/`join_game` (and `resume`) additionally return the
 * `resumeToken` — the per-session secret the client stores and presents to
 * `resume` after a reconnect (BACKLOG.md #24). It's absent on actions that don't
 * mint one (set_role, set_ready, start_game).
 */
type LobbyAck =
  | { ok: true; game: Game; playerId: string; resumeToken?: string }
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
  gameDurationMs = resolveGameDurationMs(),
  gameTimers,
  disconnectGraceMs = resolveDisconnectGraceMs(),
  disconnectTimers = defaultDisconnectTimers,
  vapidConfig: vapidConfigOption,
  subscriptions = createSubscriptionStore(),
  pushSender: pushSenderOption,
}: CreateServerOptions = {}): ServerHandle {
  const app = express();

  // Web Push (BACKLOG.md #23). `undefined` option → resolve from the env;
  // `null` → force-disabled (tests). With no config the public key is withheld,
  // so clients never subscribe, and the sender is a no-op that pushes nothing.
  const vapidConfig = vapidConfigOption === undefined ? resolveVapidConfig() : vapidConfigOption;
  const noopSender: PushSender = { send: () => Promise.resolve({ ok: true }) };
  const pushSender =
    pushSenderOption ?? (vapidConfig ? createWebPushSender(vapidConfig) : noopSender);

  // Behind the Caddy reverse proxy: trust its forwarded headers so req.secure
  // (HTTPS), req.protocol and req.ip are accurate. See resolveTrustProxy.
  app.set('trust proxy', resolveTrustProxy());

  // Liveness/readiness probe (used by the load balancer and Docker healthcheck).
  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

  // The client fetches the VAPID application-server public key before it
  // subscribes to Web Push (BACKLOG.md #23). `key` is `null` when push is
  // unconfigured, which the client reads as "feature off" and skips subscribing.
  app.get('/api/push/vapid-public-key', (_req: Request, res: Response) => {
    res.json({ key: vapidConfig?.publicKey ?? null });
  });

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

  // Web Push notifier: routes key game events (caught, reveal, time) to the
  // players who opted in, resolving recipients from the live lobby roster
  // (BACKLOG.md #23). A no-op in practice when push is unconfigured — no
  // subscriptions are ever stored, so there is no one to notify.
  const notifier = createNotifier({ store: subscriptions, sender: pushSender, roleOf });
  // Fire a notification without blocking the game loop: pushes are best-effort
  // and a slow or failing push service must never wedge a socket handler.
  const notify = (run: () => Promise<void>, label: string): void => {
    void run().catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`${label} push failed:`, reason);
    });
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
    // Nudge the hunters that a fresh fix is on the map — the one game event that
    // pushes to hunters rather than to the affected player (BACKLOG.md #23).
    notify(() => notifier.notifyReveal(gameId), 'reveal');
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

  // End-of-game tracker: remembers each active game's start, original hiders and
  // catches, and owns the survive-the-timer countdown (BACKLOG.md #15). When the
  // countdown elapses with a hider still uncaught, the hiders have survived — end
  // the game (reason `timer`). The complementary win — the last hider caught — is
  // detected on the catch path (see `claim_catch`). Both routes converge on
  // `finishGame`, which finalizes exactly once.
  const outcomeTracker = createOutcomeTracker({
    durationMs: gameDurationMs,
    ...(gameTimers ? { timers: gameTimers } : {}),
    onExpire: (gameId) => finishGame(gameId, 'timer'),
  });

  // Push the current roster/status to everyone in a room after any change.
  const emitLobby = (game: Game): void => {
    const message: LobbyUpdateEvent = { game };
    io.to(gameRoom(game.id)).emit('lobby_update', message);
  };

  // End a game on a win condition (BACKLOG.md #15). The outcome tracker finalizes
  // exactly once — a second call (the catch path and the timer racing, or a
  // torn-down game) returns no summary and this is a no-op — so both win routes
  // can safely funnel through here. On the first finalize it stops the ping
  // scheduler, moves the room to `ended`, and broadcasts `game_over` (the summary
  // payload) then the final roster so every client can switch to the end screen.
  function finishGame(gameId: string, reason: EndReason): void {
    const summary = outcomeTracker.end(gameId, reason, new Date().toISOString());
    if (!summary) return;
    pingScheduler.stop(gameId);
    const event: GameOverEvent = { gameId, summary };
    io.to(gameRoom(gameId)).emit('game_over', event);
    // Push the result to everyone still subscribed, so a backgrounded player
    // learns who won even if they never see the end screen (BACKLOG.md #23).
    notify(() => notifier.notifyGameOver(summary), 'game_over');
    // Reflect the terminal state in the roster. The room may already be gone (a
    // race with the last player leaving); tolerate that rather than throw.
    try {
      emitLobby(lobby.endGame(gameId));
    } catch (err) {
      if (!(err instanceof LobbyError)) {
        const reasonText = err instanceof Error ? err.message : String(err);
        console.error('ending game failed:', reasonText);
      }
    }
  }

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

  // Pending grace removals for players who dropped mid-match (BACKLOG.md #24),
  // keyed by game+player. A `resume` within the grace cancels the timer; the
  // grace expiring fires it and finally removes the player.
  const pendingRemovals = new Map<string, unknown>();
  const removalKey = (gameId: string, playerId: string): string => `${gameId}:${playerId}`;

  // Per-session resume tokens (BACKLOG.md #24), keyed by game+player. Minted at
  // create/join and returned only to that client, so a `resume` can prove it is
  // the same player rather than any room member who has merely seen the (public)
  // playerId in the roster. Dropped with the player.
  const resumeTokens = new Map<string, string>();
  const mintResumeToken = (gameId: string, playerId: string): string => {
    const token = randomUUID();
    resumeTokens.set(removalKey(gameId, playerId), token);
    return token;
  };

  // Drop a player from a game and sweep everything keyed to them: their geofence
  // state, push subscription, and outcome snapshot; once the room itself empties,
  // sweep the game's per-game timers and stores too. Broadcasts the updated roster
  // when the room survives. Shared by an immediate leave and a grace-period expiry.
  const forgetPlayer = (gameId: string, playerId: string): void => {
    const game = lobby.removePlayer(gameId, playerId);
    // The session is over — its resume token can never be redeemed again.
    resumeTokens.delete(removalKey(gameId, playerId));
    // Drop the departing player's geofence state so a mid-game leaver doesn't
    // leave a stale warn/eliminate entry parked for the game's lifetime; once the
    // room itself is gone, sweep whatever remains for the (recyclable) game id.
    boundaryMonitor.forget(gameId, playerId);
    if (!game) boundaryMonitor.forget(gameId);
    // Drop the leaver's push subscription so no notification is routed to a
    // player who is no longer in the game; sweep the whole game once it's gone
    // (BACKLOG.md #23).
    subscriptions.remove(gameId, playerId);
    if (!game) subscriptions.removeGame(gameId);
    // Once the room empties (the game is gone), stop its ping-reveal timer so no
    // scheduler outlives the game it reveals (BACKLOG.md #13), and drop its
    // outcome tracking so the survive-the-timer countdown can't fire on a game
    // that no longer exists (BACKLOG.md #15).
    if (!game) {
      pingScheduler.stop(gameId);
      outcomeTracker.stop(gameId);
    }
    if (game) {
      // The room lives on but this player is gone — drop them from the outcome
      // snapshot so a departed hider can't keep the last-hider win from firing or
      // be credited with a survival time (BACKLOG.md #15).
      outcomeTracker.dropPlayer(gameId, playerId);
      emitLobby(game);
    }
  };

  // Cancel a player's pending grace removal (they came back, or left cleanly).
  const cancelRemoval = (gameId: string, playerId: string): void => {
    const key = removalKey(gameId, playerId);
    const handle = pendingRemovals.get(key);
    if (handle === undefined) return;
    disconnectTimers.clearTimeout(handle);
    pendingRemovals.delete(key);
  };

  // Hold a dropped player's slot for the grace period, then remove them if they
  // never resumed. Re-arming an existing timer (a flapping connection) restarts
  // the clock rather than stacking timers.
  const scheduleRemoval = (gameId: string, playerId: string): void => {
    const key = removalKey(gameId, playerId);
    cancelRemoval(gameId, playerId);
    const handle = disconnectTimers.setTimeout(() => {
      pendingRemovals.delete(key);
      forgetPlayer(gameId, playerId);
    }, disconnectGraceMs);
    pendingRemovals.set(key, handle);
  };

  // Remove a socket from whatever lobby it currently holds: leave the socket room,
  // clear the membership, cancel any pending grace removal, and drop the player.
  // A no-op when the socket isn't in a room. Shared by leave_game and the
  // create/join/resume guard so a socket can never linger in two rooms (which
  // would leave a ghost player behind).
  const leaveCurrentLobby = (socket: Socket): void => {
    const membership = membershipOf(socket);
    if (!membership) return;
    socket.leave(gameRoom(membership.gameId));
    delete (socket.data as { lobby?: LobbyMembership }).lobby;
    cancelRemoval(membership.gameId, membership.playerId);
    forgetPlayer(membership.gameId, membership.playerId);
  };

  // Re-seed a (re)joining socket's live view with the game's current positions,
  // filtered to what this player may see, so its map isn't blank until the next
  // tick lands. Nothing reported yet is simply skipped.
  const sendSnapshot = async (socket: Socket, gameId: string, playerId: string): Promise<void> => {
    const positions = await tickEngine.latest(gameId);
    if (Object.keys(positions).length === 0) return;
    const message: GameStateEvent = {
      gameId,
      positions: visibleTo(roleOf(gameId, playerId), positions),
    };
    socket.emit('game_state', message);
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

    // Reclaim a membership after a reconnect (BACKLOG.md #24). The transport gives
    // a reconnecting client a brand-new socket the server has dropped from the
    // room, so re-emitting `join` alone would restore broadcasts but not identity
    // — its `position_update`/`claim_catch` would keep being ignored. `resume`
    // re-binds the socket's authoritative lobby identity, cancels the pending
    // removal, and re-seeds the live view.
    //
    // Identity is proven, never trusted from the payload: the caller must present
    // the `resumeToken` minted for this player at create/join (the roster exposes
    // the playerId to every member, so the token — not the id — is what
    // authenticates the claim). And it only re-binds a player who is actually
    // mid-reconnect (a pending grace removal exists), so a token can't be used to
    // seize a live session. Fails when the game/player is gone (the grace
    // elapsed), the game has ended, the token is wrong, or the player isn't
    // disconnected — the client falls back accordingly.
    socket.on('resume', (payload: unknown, ack?: (res: LobbyAck) => void) => {
      const result = validateResume(payload);
      if (!result.ok) {
        ack?.({ ok: false, error: result.error, code: result.code });
        return;
      }
      const { gameId, playerId, resumeToken } = result.value;
      const game = lobby.get(gameId);
      const player = game?.players.find((p) => p.id === playerId);
      if (!game || !player) {
        ack?.({ ok: false, error: 'That session is no longer available', code: 'player_not_found' });
        return;
      }
      // The match ended while the grace timer was still pending: the one-shot
      // `game_over` already fired and this socket missed it. Don't rebind into a
      // stale, over game — tell the client so it can reset rather than show a
      // frozen match/lobby screen.
      if (game.status === 'ended') {
        ack?.({ ok: false, error: 'That game has ended', code: 'game_ended' });
        return;
      }
      const key = removalKey(gameId, playerId);
      // Verify the session token, and that the player is genuinely mid-reconnect
      // (a pending removal is armed). Either check failing means this isn't the
      // legitimate owner resuming a dropped session.
      if (resumeTokens.get(key) !== resumeToken || !pendingRemovals.has(key)) {
        ack?.({ ok: false, error: 'That session cannot be resumed', code: 'resume_denied' });
        return;
      }
      // Never let this socket hold two memberships — drop any prior one first,
      // unless it's already bound to exactly this identity (nothing to do, and
      // dropping it would evict the very player we're resuming).
      const existing = membershipOf(socket);
      if (existing && (existing.gameId !== gameId || existing.playerId !== playerId)) {
        leaveCurrentLobby(socket);
      }
      cancelRemoval(gameId, playerId);
      (socket.data as { lobby?: LobbyMembership }).lobby = { gameId, playerId };
      socket.join(gameRoom(gameId));
      ack?.({ ok: true, game, playerId });
      void sendSnapshot(socket, gameId, playerId).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('resume snapshot failed:', reason);
      });
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
        const resumeToken = mintResumeToken(game.id, player.id);
        ack?.({ ok: true, game, playerId: player.id, resumeToken });
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
        const resumeToken = mintResumeToken(game.id, player.id);
        ack?.({ ok: true, game, playerId: player.id, resumeToken });
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
        // Begin tracking the outcome: snapshot the original hiders and arm the
        // survive-the-timer countdown (also idempotent). BACKLOG.md #15.
        outcomeTracker.start({ game, startedAt: game.startedAt ?? new Date().toISOString() });
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

    // Opt in to Web Push (BACKLOG.md #23). Identity is the socket's authoritative
    // lobby membership, never the payload, so a subscription is always filed
    // against the caller's own game and player. The payload is the browser's
    // untrusted subscription object, validated before it is stored.
    socket.on(
      'push_subscribe',
      (payload: unknown, ack?: (res: { ok: boolean; error?: string; code?: string }) => void) => {
        const result = validatePushSubscription(payload);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error, code: result.code });
          return;
        }
        const membership = membershipOf(socket);
        if (!membership) {
          ack?.({ ok: false, error: 'Not in a game', code: 'player_not_found' });
          return;
        }
        subscriptions.add(membership.gameId, membership.playerId, result.value);
        ack?.({ ok: true });
      },
    );

    // Opt back out of Web Push: drop the caller's stored subscription. Carries no
    // payload — identity comes from the socket's membership.
    socket.on('push_unsubscribe', (_payload: unknown, ack?: (res: { ok: boolean }) => void) => {
      const membership = membershipOf(socket);
      if (membership) subscriptions.remove(membership.gameId, membership.playerId);
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
        // Tell the caught hider they've been tagged — the event that most wants a
        // push, since they may have the app backgrounded (BACKLOG.md #23).
        notify(() => notifier.notifyCaught(gameId, confirmed), 'caught');
        // Record the catch for the end-screen summary and the win check (BACKLOG.md #15).
        outcomeTracker.recordCatch(gameId, confirmed);
        emitLobby(game);
        ack?.({ ok: true, catch: confirmed });
        // Win condition: that catch may have taken the last free hider. If no
        // hider remains, the hunters have won — end the game and fan out the
        // summary (after the catch/roster broadcasts, so clients see the final
        // catch before the end screen).
        if (outcomeTracker.remainingHiders(gameId) === 0) {
          finishGame(gameId, 'all_caught');
        }
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
      const membership = membershipOf(socket);
      if (!membership) return;
      const game = lobby.get(membership.gameId);
      // Signal loss mid-match: hold the player's slot for the grace period so an
      // auto-reconnecting client can `resume` the same identity instead of being
      // dropped and having to re-join fresh (BACKLOG.md #24). The socket is
      // already gone (Socket.IO leaves its rooms on disconnect), so we only clear
      // our own membership record and arm the removal timer. In the lobby (before
      // start) or once the game has ended there's nothing to preserve — and with
      // the grace disabled (`0`) we never defer — so drop immediately as before.
      if (game?.status === 'active' && disconnectGraceMs > 0) {
        delete (socket.data as { lobby?: LobbyMembership }).lobby;
        scheduleRemoval(membership.gameId, membership.playerId);
      } else {
        leaveCurrentLobby(socket);
      }
    });
  });

  return {
    app,
    httpServer,
    io,
    liveState,
    lobby,
    tickEngine,
    boundaryMonitor,
    pingScheduler,
    outcomeTracker,
    subscriptions,
    notifier,
  };
}
