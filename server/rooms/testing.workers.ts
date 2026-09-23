/**
 * Helpers for the Durable Object WebSocket tests: seat players over HTTP, then
 * follow what the Game sends each Seat's socket.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import type { Game } from '../../shared/index.ts';
import { PROTOCOL_VERSION } from '../../shared/version.ts';

export const ORIGIN = 'https://manhunt.example';

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

export const createGame = () => enter('/api/games', { name: 'Ada' });
export const joinGame = (code: string) => enter('/api/games/join', { code, name: 'Bo' });

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
