import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_CODES,
  HEARTBEAT,
  isRequestFrame,
  parseFrame,
  type ErrorAck,
  type Game,
} from '../../shared/index.ts';
import {
  createGame,
  GameError,
  restoreGame,
  SNAPSHOT_VERSION,
  type Effect,
  type GameCore,
} from '../game/game.ts';
import { readSeatToken, rejectSocket } from '../seat.ts';

/** What a socket carries through hibernation. */
interface Attachment {
  playerId: string;
}

export type CreateResult =
  | { ok: true; game: Game; playerId: string; token: string }
  | { ok: false; code: 'join_code_taken' }
  | { ok: false; code: 'name_required'; error: string };

/**
 * One Game, addressed by `idFromName(joinCode)`. Hosts the game core: applies
 * commands, carries out their effects and persists the snapshot in SQLite.
 */
export class GameRoom extends DurableObject<Cloudflare.Env> {
  private game: GameCore | undefined;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // Answered by the runtime without waking a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT.ping, HEARTBEAT.pong));
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL, version INTEGER NOT NULL)',
    );
    const row = ctx.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM game WHERE id = 1').toArray()[0];
    if (row) this.game = restoreGame(JSON.parse(row.snapshot));
  }

  /** Claim this object's Join code for a new Game hosted by `hostName`. */
  async create(joinCode: string, hostName: unknown): Promise<CreateResult> {
    if (this.game) return { ok: false, code: 'join_code_taken' };
    let game: GameCore;
    try {
      game = createGame(
        { playerId: crypto.randomUUID(), name: hostName, token: crypto.randomUUID() },
        { gameId: this.ctx.id.toString(), joinCode, now: Date.now() },
      );
    } catch (error) {
      if (error instanceof GameError && error.code === 'name_required') {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
    this.game = game;
    this.persist();
    console.log(JSON.stringify({ event: 'game_created', gameId: this.ctx.id.toString() }));
    const host = game.snapshot().seats[0]!;
    return { ok: true, game: game.lobby(), playerId: host.playerId, token: host.token };
  }

  /** A socket upgrade the Worker has already checked for `Origin` and a Seat cookie. */
  override async fetch(request: Request): Promise<Response> {
    const token = readSeatToken(request);
    const playerId = token ? this.game?.seatFor(token) : undefined;
    if (!this.game || !playerId) return rejectSocket(CLOSE_CODES.seatRejected, 'Seat rejected');

    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged by Seat so effects can address it; accepted for hibernation.
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId } satisfies Attachment);
    this.run(this.game.apply({ type: 'seat_reconnected', playerId }, Date.now()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    const frame = parseFrame(message);
    if (frame && isRequestFrame(frame)) {
      const body: ErrorAck = { ok: false, error: 'Not available yet', code: 'unsupported' };
      ws.send(JSON.stringify({ re: frame.id, d: body }));
    }
  }

  private run(effects: Effect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'send': {
          const text = JSON.stringify(effect.message);
          for (const ws of this.socketsFor(effect.to)) ws.send(text);
          break;
        }
        case 'close':
          for (const ws of this.ctx.getWebSockets(effect.seat)) ws.close(effect.code);
          break;
        case 'durableChanged':
          this.persist();
          break;
      }
    }
  }

  private socketsFor(to: Extract<Effect, { type: 'send' }>['to']): WebSocket[] {
    if (to === 'everyone') return this.ctx.getWebSockets();
    if ('seat' in to) return this.ctx.getWebSockets(to.seat);
    const seats = new Set(
      this.game?.snapshot().seats.filter((s) => s.role === to.role).map((s) => s.playerId),
    );
    return this.ctx
      .getWebSockets()
      .filter((ws) => seats.has((ws.deserializeAttachment() as Attachment).playerId));
  }

  private persist(): void {
    if (!this.game) return;
    this.ctx.storage.sql.exec(
      'INSERT INTO game (id, snapshot, version) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot, version = excluded.version',
      JSON.stringify(this.game.snapshot()),
      SNAPSHOT_VERSION,
    );
  }
}
