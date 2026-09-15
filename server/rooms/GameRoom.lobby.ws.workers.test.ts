import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../../shared/index.ts';
import { PROTOCOL_VERSION } from '../../shared/version.ts';
import { DEFAULT_GRACE_MS } from '../game/game.ts';

const ORIGIN = 'https://manhunt.example';

interface Seated {
  game: Game;
  playerId: string;
  token: string;
}

/** A frame the Game sent, loosely typed for matching. */
interface Received {
  t?: string;
  re?: number;
  d?: unknown;
}

async function enter(path: string, body: unknown): Promise<Seated> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  const token = /^seat=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1];
  if (!token) throw new Error(`expected a Seat cookie, got ${res.status}`);
  return { ...((await res.json()) as { game: Game; playerId: string }), token };
}

const createGame = () => enter('/api/games', { name: 'Ada' });
const joinGame = (code: string) => enter('/api/games/join', { code, name: 'Bo' });

/** A Seat's socket that buffers everything the Game sends. */
async function connect(gameId: string, token: string) {
  const res = await SELF.fetch(`${ORIGIN}/ws/games/${gameId}?v=${PROTOCOL_VERSION}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN, Cookie: `seat=${token}` },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected a WebSocket, got ${res.status}`);
  const received: Received[] = [];
  let wake: (() => void) | undefined;
  ws.addEventListener('message', (event) => {
    received.push(JSON.parse(String(event.data)) as Received);
    wake?.();
  });
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code));
  });
  ws.accept();

  /** Take the first received frame that matches, waiting for it if needed. */
  const next = async (match: (frame: Received) => boolean): Promise<Received> => {
    for (;;) {
      const index = received.findIndex(match);
      if (index >= 0) return received.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  let lastId = 0;
  const request = async (t: string, d: unknown): Promise<unknown> => {
    lastId += 1;
    const id = lastId;
    ws.send(JSON.stringify({ t, id, d }));
    return (await next((frame) => frame.re === id)).d;
  };

  return { ws, closed, next, request };
}

/** Matches a `lobby_update` whose Game satisfies `check`. */
function lobbyWhere(check: (game: Game) => boolean = () => true) {
  return (frame: Received) => frame.t === 'lobby_update' && check((frame.d as { game: Game }).game);
}

function stubFor(gameId: string) {
  return env.GAMES.get(env.GAMES.idFromString(gameId));
}

function alarmOf(gameId: string): Promise<number | null> {
  return runInDurableObject(stubFor(gameId), (_room, state) => state.storage.getAlarm());
}

/** The Host's and a joined Hider's Seats, both connected and past their first snapshot. */
async function twoSeats() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  return { host, bo, hostSocket, boSocket };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameRoom Lobby', () => {
  it('tells every connected Seat when a player joins', async () => {
    const host = await createGame();
    const hostSocket = await connect(host.game.id, host.token);
    await hostSocket.next(lobbyWhere());

    const bo = await joinGame(host.game.roomCode);

    expect((await hostSocket.next(lobbyWhere())).d).toEqual({ game: bo.game });
    hostSocket.ws.close(1000, 'done');
  });

  it('answers a Lobby request and tells everyone about the change', async () => {
    const { bo, hostSocket, boSocket } = await twoSeats();

    const reply = await boSocket.request('set_ready', { ready: true });

    expect(reply).toMatchObject({ ok: true, playerId: bo.playerId });
    await hostSocket.next(lobbyWhere((game) => game.players.some((p) => p.id === bo.playerId && p.ready)));
    hostSocket.ws.close(1000, 'done');
    boSocket.ws.close(1000, 'done');
  });

  it('closes the older socket for the same Seat with 4003 and keeps the Seat on the newer one', async () => {
    const host = await createGame();
    const first = await connect(host.game.id, host.token);
    await first.next(lobbyWhere());

    const second = await connect(host.game.id, host.token);

    expect(await first.closed).toBe(4003);
    await second.next(lobbyWhere());
    expect(await second.request('set_ready', { ready: true })).toMatchObject({ ok: true });
    expect(await alarmOf(host.game.id)).toBeNull();
    second.ws.close(1000, 'done');
  });

  it('releases a dropped Seat on the alarm after its Grace period and rejects its return with 4001', async () => {
    const { host, bo, hostSocket, boSocket } = await twoSeats();

    boSocket.ws.close(1000, 'gone');
    await vi.waitFor(async () => expect(await alarmOf(host.game.id)).not.toBeNull());
    const later = Date.now() + DEFAULT_GRACE_MS + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect(await runDurableObjectAlarm(stubFor(host.game.id))).toBe(true);
    vi.restoreAllMocks();

    await hostSocket.next(lobbyWhere((game) => game.players.every((p) => p.id !== bo.playerId)));
    const back = await connect(host.game.id, bo.token);
    expect(await back.closed).toBe(4001);
    hostSocket.ws.close(1000, 'done');
  });

  it('keeps a dropped Seat that reconnects within its Grace period', async () => {
    const { host, bo, hostSocket, boSocket } = await twoSeats();

    boSocket.ws.close(1000, 'gone');
    await vi.waitFor(async () => expect(await alarmOf(host.game.id)).not.toBeNull());
    const back = await connect(host.game.id, bo.token);

    expect((await back.next(lobbyWhere())).d).toMatchObject({ game: { players: [{}, { id: bo.playerId }] } });
    await vi.waitFor(async () => expect(await alarmOf(host.game.id)).toBeNull());
    hostSocket.ws.close(1000, 'done');
    back.ws.close(1000, 'done');
  });

  it('closes a leaving Seat with 4001 after its reply and tells everyone', async () => {
    const { host, bo, hostSocket, boSocket } = await twoSeats();

    expect(await boSocket.request('leave_game', undefined)).toEqual({ ok: true });

    expect(await boSocket.closed).toBe(4001);
    await hostSocket.next(lobbyWhere((game) => game.players.length === 1));
    const back = await connect(host.game.id, bo.token);
    expect(await back.closed).toBe(4001);
    hostSocket.ws.close(1000, 'done');
  });
});
