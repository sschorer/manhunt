/**
 * Helpers for the Durable Object WebSocket tests: seat players over HTTP, then
 * follow what the Game sends each Seat's socket.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import type { Game, GameStateEvent } from '../../shared/index.ts';
import { PROTOCOL_VERSION } from '../../shared/version.ts';

export const ORIGIN = 'https://manhunt.example';

/** The names the helpers seat players under. */
export const NAMES = { host: 'Ada', bo: 'Bo' } as const;

/** The fixes {@link placedGame} has each side report. */
export const FIXES = { host: { lat: 52.2, lng: 4.4 }, bo: { lat: 52.1, lng: 4.3 } } as const;

export interface Seated {
  game: Game;
  playerId: string;
  token: string;
}

/** A frame the Game sent, loosely typed for matching. */
export interface Received {
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

export const createGame = () => enter('/api/games', { name: NAMES.host });
export const joinGame = (code: string) => enter('/api/games/join', { code, name: NAMES.bo });

/** A Seat's socket that buffers everything the Game sends. */
export async function connect(gameId: string, token: string) {
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

  /** Send an event frame, which gets no reply. */
  const send = (t: string, d: unknown): void => ws.send(JSON.stringify({ t, d }));

  return { ws, closed, next, request, send };
}

/** Matches a `game_state` whose event satisfies `check`. */
export function stateWhere(check: (event: GameStateEvent) => boolean = () => true) {
  return (frame: Received) => frame.t === 'game_state' && check(frame.d as GameStateEvent);
}

/** The Host (a Hunter) and Bo (a Hider), both connected, past their first snapshot and ready. */
export async function readySeats() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  return { host, bo, hostSocket, boSocket };
}

/** {@link readySeats}, with the Game started; `startedAt` is the moment the Host started it. */
export async function startedGame() {
  const seats = await readySeats();
  const started = (await seats.hostSocket.request('start_game', {})) as { ok: boolean; game: Game };
  expect(started).toMatchObject({ ok: true });
  return { ...seats, startedAt: Date.parse(started.game.startedAt!) };
}

/** {@link startedGame}, with both sides having reported the {@link FIXES}. */
export async function placedGame() {
  const game = await startedGame();
  const { host, bo, hostSocket, boSocket } = game;
  hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, ...FIXES.host });
  boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, ...FIXES.bo });
  await boSocket.next(stateWhere((event) => host.playerId in event.positions && bo.playerId in event.positions));
  return game;
}

/** Matches a `lobby_update` whose Game satisfies `check`. */
export function lobbyWhere(check: (game: Game) => boolean = () => true) {
  return (frame: Received) => frame.t === 'lobby_update' && check((frame.d as { game: Game }).game);
}

export function stubFor(gameId: string) {
  return env.GAMES.get(env.GAMES.idFromString(gameId));
}

export function alarmOf(gameId: string): Promise<number | null> {
  return runInDurableObject(stubFor(gameId), (_room, state) => state.storage.getAlarm());
}
