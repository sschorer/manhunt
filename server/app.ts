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
import { Server, type DefaultEventsMap } from 'socket.io';
import {
  createLiveState,
  type LiveState,
  type Position,
  type PlayerRole,
  type PositionsByPlayer,
  type GameStateMessage,
} from './live/index.ts';

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
}

export interface ServerHandle {
  app: Express;
  httpServer: http.Server;
  io: Server;
  liveState: LiveState;
}

/** Socket.IO room a game's broadcasts are emitted to. */
function gameRoom(gameId: string): string {
  return `game:${gameId}`;
}

/**
 * The server-side identity bound to a socket at `join`. Position updates trust
 * this — never the client-supplied payload — so a socket can only write its own
 * player's position and can't spoof another.
 */
interface SocketIdentity {
  gameId: string;
  playerId: string;
  role: PlayerRole;
}

/** Per-socket state the live handlers keep on `socket.data`. */
interface SocketState {
  identity?: SocketIdentity;
  /** Epoch ms of the last accepted `position_update`, for rate limiting. */
  lastPositionAt?: number;
}

/**
 * Minimum spacing between accepted position updates. Clients tick every 5–10s
 * (see docs); this is a generous anti-flood floor well below that, so a buggy
 * or malicious client can't hammer writes/broadcasts faster than the server is
 * willing to fan out.
 */
const MIN_POSITION_INTERVAL_MS = 1000;

/** Validate an untrusted `join` payload into a server-side identity. */
function readJoin(payload: unknown): SocketIdentity | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { gameId, playerId, role } = payload as Record<string, unknown>;
  if (typeof gameId !== 'string' || !gameId) return undefined;
  if (typeof playerId !== 'string' || !playerId) return undefined;
  if (role !== 'hunter' && role !== 'hider') return undefined;
  return { gameId, playerId, role };
}

/**
 * Validate the untrusted half of a `position_update`: only the coordinates are
 * ever taken from the client. Identity (game, player, role) comes from the
 * socket's `join`, so it can't be forged in the payload.
 */
function readPosition(payload: unknown): Position | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { lat, lng } = payload as Record<string, unknown>;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return undefined;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return undefined;
  // Reject coordinates outside the valid geographic range. Per-game *playable*
  // boundary enforcement (geofence) is a separate concern — see BACKLOG.md #11.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng, recordedAt: new Date().toISOString() };
}

/**
 * Filter a game's positions for a single recipient. Fails closed: a hunter only
 * ever sees positions explicitly marked `hunter`, so anything unlabelled (a
 * hider, or a record missing its role) is withheld rather than leaked. The
 * scheduled-reveal exception is part of the rules engine (see BACKLOG.md #14).
 * The stored `role` marker is stripped so the roster isn't leaked to clients.
 */
function visibleTo(
  role: PlayerRole | undefined,
  positions: PositionsByPlayer,
): PositionsByPlayer {
  const out: PositionsByPlayer = {};
  for (const [playerId, pos] of Object.entries(positions)) {
    if (role === 'hunter' && pos.role !== 'hunter') continue;
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
 * Build the Express app + HTTP server + Socket.IO instance without starting to
 * listen. Kept separate from `index.ts` so tests can drive it on an ephemeral
 * port and tear it down cleanly.
 */
export function createServer({
  staticDir = resolveStaticDir(),
  liveState = createLiveState(),
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
  const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketState>(
    httpServer,
  );
  const { store, broadcaster } = liveState;

  // Fan-out path: a game-state message — published locally or received from
  // another instance over Redis pub/sub — is emitted to the game's sockets on
  // THIS instance, filtered per recipient's role so hunters never receive hider
  // coordinates (see BACKLOG.md #14).
  async function fanOut({ gameId, positions }: GameStateMessage): Promise<void> {
    const sockets = await io.in(gameRoom(gameId)).fetchSockets();
    for (const s of sockets) {
      s.emit('game_state', { gameId, positions: visibleTo(s.data.identity?.role, positions) });
    }
  }
  broadcaster.subscribe((message) => {
    void fanOut(message).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('game_state fan-out failed:', reason);
    });
  });

  // Authoritative game loop. Only the live-state wiring (join room +
  // position_update tick) is implemented here; claim_catch and the rules
  // engine are tracked in the backlog.
  io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.id}`);

    // Bind the socket's identity and subscribe it to its game's broadcasts.
    // Acks so callers can await it.
    socket.on('join', (payload: unknown, ack?: (res: { ok: boolean }) => void) => {
      const identity = readJoin(payload);
      if (identity) {
        socket.data.identity = identity;
        socket.join(gameRoom(identity.gameId));
      }
      if (typeof ack === 'function') ack({ ok: Boolean(identity) });
    });

    // One tick: a client reports its coordinates. The server trusts the socket's
    // bound identity (not the payload) for who/which game, throttles to the tick
    // cadence, writes to the hot store, and publishes for cross-instance fan-out.
    socket.on('position_update', async (payload: unknown) => {
      const { identity } = socket.data;
      if (!identity) return; // must join first — no identity, no write
      const position = readPosition(payload);
      if (!position) return;

      const now = Date.now();
      if (now - (socket.data.lastPositionAt ?? 0) < MIN_POSITION_INTERVAL_MS) return;
      socket.data.lastPositionAt = now;

      const { gameId, playerId, role } = identity;
      try {
        await store.writePosition(gameId, playerId, { ...position, role });
        const positions = await store.readPositions(gameId);
        await broadcaster.publish({ gameId, positions });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error('position_update failed:', reason);
      }
    });

    socket.on('disconnect', () => console.log(`socket disconnected: ${socket.id}`));
  });

  return { app, httpServer, io, liveState };
}
