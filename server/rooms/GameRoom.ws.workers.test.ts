import { env, evictDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../shared/version.ts';

const ORIGIN = 'https://manhunt.example';

async function createGame(): Promise<{ game: { id: string; roomCode: string }; token: string }> {
  const res = await SELF.fetch(`${ORIGIN}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ name: 'Ada' }),
  });
  const { game } = (await res.json()) as { game: { id: string; roomCode: string } };
  const token = /^seat=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1];
  if (!token) throw new Error('expected a Seat cookie');
  return { game, token };
}

async function connect(gameId: string, token: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${ORIGIN}/ws/games/${gameId}?v=${PROTOCOL_VERSION}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN, Cookie: `seat=${token}` },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected a WebSocket, got ${res.status}`);
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
  });
}

describe('GameRoom', () => {
  it('sends the Lobby snapshot to a Seat when its socket connects', async () => {
    const { game, token } = await createGame();

    const ws = await connect(game.id, token);

    expect(JSON.parse(await nextMessage(ws))).toEqual({ t: 'lobby_update', d: { game } });
    ws.close(1000, 'done');
  });

  it('keeps the Game across an eviction and restores it from storage', async () => {
    const { game, token } = await createGame();
    const stub = env.GAMES.get(env.GAMES.idFromString(game.id));

    await evictDurableObject(stub);
    const ws = await connect(game.id, token);

    expect(JSON.parse(await nextMessage(ws))).toEqual({ t: 'lobby_update', d: { game } });
    ws.close(1000, 'done');
  });

  it('keeps the Join code claimed across an eviction', async () => {
    const { game } = await createGame();
    const stub = env.GAMES.get(env.GAMES.idFromName(game.roomCode));

    await evictDurableObject(stub);

    expect(await stub.create(game.roomCode, 'Mallory')).toEqual({ ok: false, code: 'join_code_taken' });
  });

  it('answers the "ping" heartbeat with "pong"', async () => {
    const { game, token } = await createGame();
    const ws = await connect(game.id, token);
    await nextMessage(ws);

    ws.send('ping');

    expect(await nextMessage(ws)).toBe('pong');
    ws.close(1000, 'done');
  });

  it('replies to requests it cannot handle yet instead of leaving them pending', async () => {
    const { game, token } = await createGame();
    const ws = await connect(game.id, token);
    await nextMessage(ws);

    ws.send(JSON.stringify({ t: 'start_game', id: 7, d: {} }));

    expect(JSON.parse(await nextMessage(ws))).toEqual({
      re: 7,
      d: { ok: false, error: expect.any(String), code: 'unsupported' },
    });
    ws.close(1000, 'done');
  });
});
