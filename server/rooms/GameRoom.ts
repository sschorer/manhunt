import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE_CODES,
  HEARTBEAT,
  isEventFrame,
  isRequestFrame,
  parseFrame,
  type ErrorAck,
  type Game,
  type Position,
  type PositionsByPlayer,
} from '../../shared/index.ts';
import {
  createGame,
  GameError,
  restoreGame,
  SNAPSHOT_VERSION,
  type Effect,
  type GameConfig,
  type GameCore,
} from '../game/game.ts';
import { gameConfigFrom } from '../rules.ts';
import { readSeatToken, rejectSocket } from '../seat.ts';

/**
 * What a socket carries through hibernation: its Seat and that Seat's latest
 * position, which is never written to storage.
 */
interface Attachment {
  playerId: string;
  position?: Position;
}

export type CreateResult =
  | { ok: true; game: Game; playerId: string; token: string }
  | { ok: false; code: 'join_code_taken' }
  | { ok: false; code: 'name_required'; error: string };

export type JoinResult =
  | { ok: true; game: Game; playerId: string; token: string }
  | { ok: false; code: 'game_not_found' | 'already_started' | 'name_required'; error: string };

/** The requests a Seat may send over its socket, each applied as the command of the same name. */
const SEAT_REQUESTS = new Set([
  'set_role',
  'set_ready',
  'set_boundary',
  'start_game',
  'leave_game',
  'claim_catch',
] as const);
type SeatRequestType = typeof SEAT_REQUESTS extends Set<infer T> ? T : never;

function isSeatRequest(type: string): type is SeatRequestType {
  return SEAT_REQUESTS.has(type as SeatRequestType);
}

/**
 * One Game, addressed by `idFromName(joinCode)`. Hosts the game core: applies
 * commands, carries out their effects and persists the snapshot in SQLite.
 */
export class GameRoom extends DurableObject<Cloudflare.Env> {
  private game: GameCore | undefined;
  private readonly config: GameConfig;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.config = gameConfigFrom(env);
    // Answered by the runtime without waking a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT.ping, HEARTBEAT.pong));
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL, version INTEGER NOT NULL)',
    );
    const row = ctx.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM game WHERE id = 1').toArray()[0];
    if (row) this.game = restoreGame(JSON.parse(row.snapshot), this.config, this.positionsFromSockets());
  }

  /** Claim this object's Join code for a new Game hosted by `hostName`. */
  async create(joinCode: string, hostName: unknown): Promise<CreateResult> {
    if (this.game) return { ok: false, code: 'join_code_taken' };
    let game: GameCore;
    try {
      game = createGame(
        { playerId: crypto.randomUUID(), name: hostName, token: crypto.randomUUID() },
        { gameId: this.ctx.id.toString(), joinCode, now: Date.now() },
        this.config,
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

  /** Seat a player who joined by this Game's Join code. */
  async join(name: unknown): Promise<JoinResult> {
    if (!this.game) return { ok: false, code: 'game_not_found', error: 'No Game with that Join code' };
    const playerId = crypto.randomUUID();
    const token = crypto.randomUUID();
    try {
      this.run(this.game.apply({ type: 'join', playerId, name, token }, Date.now()));
    } catch (error) {
      if (error instanceof GameError && (error.code === 'already_started' || error.code === 'name_required')) {
        return { ok: false, code: error.code, error: error.message };
      }
      throw error;
    }
    return { ok: true, game: this.game.lobby(), playerId, token };
  }

  /** A socket upgrade the Worker has already checked for `Origin` and a Seat cookie. */
  override async fetch(request: Request): Promise<Response> {
    const token = readSeatToken(request);
    const playerId = token ? this.game?.seatFor(token) : undefined;
    if (!this.game || !playerId) return rejectSocket(CLOSE_CODES.seatRejected, 'Seat rejected');

    // A newer socket for the same Seat (another tab, a reload) takes over.
    for (const old of this.ctx.getWebSockets(playerId)) old.close(CLOSE_CODES.replaced, 'Replaced');

    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged by Seat so effects can address it; accepted for hibernation.
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, position: this.game.positions()[playerId] } satisfies Attachment);
    this.run(this.game.apply({ type: 'seat_reconnected', playerId }, Date.now()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    const frame = parseFrame(message);
    if (!frame) return;
    const { playerId } = ws.deserializeAttachment() as Attachment;
    if (isEventFrame(frame)) {
      if (this.game && frame.t === 'position_update') {
        this.run(this.game.apply({ type: 'position_update', playerId, payload: frame.d }, Date.now()));
      }
      return;
    }
    if (!isRequestFrame(frame)) return;
    if (!this.game || !isSeatRequest(frame.t)) {
      const body: ErrorAck = { ok: false, error: 'Not available yet', code: 'unsupported' };
      ws.send(JSON.stringify({ re: frame.id, d: body }));
      return;
    }
    const command = { type: frame.t, playerId, requestId: frame.id, payload: frame.d };
    this.run(this.game.apply(command, Date.now()), ws);
  }

  override webSocketClose(ws: WebSocket): void {
    this.dropped(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.dropped(ws);
  }

  override alarm(): void {
    if (this.game) this.run(this.game.apply({ type: 'timers_due' }, Date.now()));
  }

  /** A closed socket drops its Seat, unless a newer socket for the Seat took over. */
  private dropped(ws: WebSocket): void {
    if (!this.game) return;
    const { playerId } = ws.deserializeAttachment() as Attachment;
    const replaced = this.ctx
      .getWebSockets(playerId)
      .some((other) => other !== ws && other.readyState === WebSocket.OPEN);
    if (!replaced) this.run(this.game.apply({ type: 'seat_dropped', playerId }, Date.now()));
  }

  /** Carry out effects; replies go to `origin`, the socket whose request produced them. */
  private run(effects: Effect[], origin?: WebSocket): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'send': {
          const text = JSON.stringify(effect.message);
          for (const ws of this.socketsFor(effect.to)) ws.send(text);
          break;
        }
        case 'reply':
          origin?.send(JSON.stringify({ re: effect.requestId, d: effect.body }));
          break;
        case 'close':
          for (const ws of this.socketsFor({ seat: effect.seat })) ws.close(effect.code);
          break;
        case 'durableChanged':
          this.persist();
          break;
        case 'positionChanged':
          for (const ws of this.socketsFor({ seat: effect.seat })) {
            ws.serializeAttachment({ playerId: effect.seat, position: effect.position } satisfies Attachment);
          }
          break;
      }
    }
    if (effects.some((effect) => effect.type === 'durableChanged')) this.scheduleAlarm();
  }

  /**
   * Positions mirrored onto the open sockets, which survive a hibernation. A Seat
   * whose socket already closed has no attachment left, so its position is lost
   * until its next update; positions are never written to storage.
   */
  private positionsFromSockets(): PositionsByPlayer {
    const positions: PositionsByPlayer = {};
    for (const ws of this.ctx.getWebSockets()) {
      const { playerId, position } = ws.deserializeAttachment() as Attachment;
      if (position) positions[playerId] = position;
    }
    return positions;
  }

  /** Keep the single alarm on the Game's next deadline. */
  private scheduleAlarm(): void {
    const deadline = this.game?.nextDeadline() ?? null;
    if (deadline === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(deadline);
  }

  /** The open sockets for an audience; a replaced or closing socket is still listed until it is gone. */
  private socketsFor(to: Extract<Effect, { type: 'send' }>['to']): WebSocket[] {
    const open = (sockets: WebSocket[]) => sockets.filter((ws) => ws.readyState === WebSocket.OPEN);
    if (to === 'everyone') return open(this.ctx.getWebSockets());
    if ('seat' in to) return open(this.ctx.getWebSockets(to.seat));
    const seats = new Set(
      this.game?.snapshot().seats.filter((s) => s.role === to.role).map((s) => s.playerId),
    );
    return open(this.ctx.getWebSockets()).filter((ws) =>
      seats.has((ws.deserializeAttachment() as Attachment).playerId),
    );
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
