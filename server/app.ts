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
import { Server } from 'socket.io';
import { createLiveState, type LiveState, type Position } from './live/index.ts';

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

interface PositionUpdate {
  gameId: string;
  playerId: string;
  position: Position;
}

/** Extract a non-empty `gameId` from an untrusted socket payload. */
function readGameId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { gameId } = payload as { gameId?: unknown };
  return typeof gameId === 'string' && gameId ? gameId : undefined;
}

/**
 * Validate an untrusted `position_update` payload. Returns the normalized
 * update, or `undefined` if any field is missing or malformed. Positions are
 * advisory input — authoritative rules (boundary, catch, role filtering) are
 * layered on later (see BACKLOG.md).
 */
function readPositionUpdate(payload: unknown): PositionUpdate | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { gameId, playerId, lat, lng } = payload as Record<string, unknown>;
  if (typeof gameId !== 'string' || !gameId) return undefined;
  if (typeof playerId !== 'string' || !playerId) return undefined;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return undefined;
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return undefined;
  return {
    gameId,
    playerId,
    position: { lat, lng, recordedAt: new Date().toISOString() },
  };
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

  // Single fan-out path: a game-state message — published locally or received
  // from another instance over Redis pub/sub — is emitted to every socket in
  // that game's room. Per-role visibility filtering is layered on later (see
  // BACKLOG.md #14).
  broadcaster.subscribe(({ gameId, positions }) => {
    io.to(gameRoom(gameId)).emit('game_state', { gameId, positions });
  });

  // Authoritative game loop. Only the live-state wiring (join room +
  // position_update tick) is implemented here; claim_catch and the rules
  // engine are tracked in the backlog.
  io.on('connection', (socket) => {
    console.log(`socket connected: ${socket.id}`);

    // Subscribe a socket to a game's broadcasts. Acks so callers can await it.
    socket.on('join', (payload: unknown, ack?: (res: { ok: boolean }) => void) => {
      const gameId = readGameId(payload);
      if (gameId) socket.join(gameRoom(gameId));
      if (typeof ack === 'function') ack({ ok: Boolean(gameId) });
    });

    // One tick: a client reports its position. The server writes it to the hot
    // store and publishes the game's live positions for cross-instance fan-out.
    socket.on('position_update', async (payload: unknown) => {
      const update = readPositionUpdate(payload);
      if (!update) return;
      const { gameId, playerId, position } = update;
      socket.join(gameRoom(gameId));
      try {
        await store.writePosition(gameId, playerId, position);
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
