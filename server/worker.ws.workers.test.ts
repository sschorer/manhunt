import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../shared/version.ts';

const ORIGIN = 'https://manhunt.example';

async function createGame(): Promise<{ gameId: string; token: string }> {
  const res = await SELF.fetch(`${ORIGIN}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ name: 'Ada' }),
  });
  const { game } = (await res.json()) as { game: { id: string } };
  const token = /^seat=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1];
  if (!token) throw new Error('expected a Seat cookie');
  return { gameId: game.id, token };
}

async function connect(gameId: string, headers: Record<string, string>, version = PROTOCOL_VERSION) {
  const res = await SELF.fetch(`${ORIGIN}/ws/games/${gameId}?v=${version}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN, ...headers },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`expected a WebSocket, got ${res.status}`);
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (event) => resolve(event.code));
  });
  ws.accept();
  return { ws, closed };
}

function socketsInGame(gameId: string): Promise<number> {
  const stub = env.GAMES.get(env.GAMES.idFromString(gameId));
  return runInDurableObject(stub, (_room, state) => state.getWebSockets().length);
}

describe('GET /ws/games/:gameId seat check', () => {
  it('closes a socket without a Seat cookie with 4001 before it reaches the Game', async () => {
    const { gameId } = await createGame();

    const { closed } = await connect(gameId, {});

    expect(await closed).toBe(4001);
    expect(await socketsInGame(gameId)).toBe(0);
  });

  it('closes a socket with a foreign Seat token with 4001 before it reaches the Game', async () => {
    const { gameId } = await createGame();
    const other = await createGame();

    const { closed } = await connect(gameId, { Cookie: `seat=${other.token}` });

    expect(await closed).toBe(4001);
    expect(await socketsInGame(gameId)).toBe(0);
  });

  it('closes a socket for a malformed Game id with 4001', async () => {
    const { token } = await createGame();

    const { closed } = await connect('not-a-game', { Cookie: `seat=${token}` });

    expect(await closed).toBe(4001);
  });

  it('closes a socket from an outdated protocol version with 4004', async () => {
    const { gameId, token } = await createGame();

    const { closed } = await connect(gameId, { Cookie: `seat=${token}` }, PROTOCOL_VERSION - 1);

    expect(await closed).toBe(4004);
    expect(await socketsInGame(gameId)).toBe(0);
  });
});
