import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../shared/version.ts';
import worker from './worker.ts';

const ORIGIN = 'https://manhunt.example';

function createGame(body: unknown = { name: 'Ada' }): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker', () => {
  it('reports ok, the build version and the protocol version on /health', async () => {
    const res = await SELF.fetch('http://example.com/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: __MANHUNT_VERSION__,
      protocol: PROTOCOL_VERSION,
    });
    expect(__MANHUNT_VERSION__).not.toBe('');
  });

  it('answers unknown Worker routes with 404', async () => {
    const res = await SELF.fetch('http://example.com/api/nope');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/games', () => {
  it('creates a Game in its Lobby with the caller as Host and a Join code', async () => {
    const res = await createGame({ name: 'Ada' });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { game: { id: string; roomCode: string }; playerId: string };
    expect(body).toEqual({
      playerId: expect.any(String),
      game: {
        id: expect.any(String),
        roomCode: expect.stringMatching(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/),
        status: 'lobby',
        createdAt: expect.any(String),
        players: [{ id: body.playerId, name: 'Ada', role: 'hunter', ready: false, isHost: true }],
      },
    });
    // The Game is the Durable Object named by its Join code.
    expect(body.game.id).toBe(env.GAMES.idFromName(body.game.roomCode).toString());
  });

  it('sets a secret Seat cookie scoped to the Game socket path', async () => {
    const res = await createGame();
    const { game } = (await res.json()) as { game: { id: string } };

    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(
      new RegExp(`^seat=[\\w-]{16,}; HttpOnly; Secure; SameSite=Strict; Path=/ws/games/${game.id}$`),
    );
  });

  it('retries with another Join code when the first is taken', async () => {
    // Every Join code character is drawn from one random byte.
    const bytes = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) array[i] = bytes.shift() ?? 2;
      return array;
    }) as typeof crypto.getRandomValues);

    const first = (await (await createGame()).json()) as { game: { roomCode: string } };
    const second = (await (await createGame()).json()) as { game: { roomCode: string } };

    expect(first.game.roomCode).toBe('AAAA');
    expect(second.game.roomCode).toBe('BBBB');
  });

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['a body that is not JSON', '{'],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await createGame(body);

    expect(res.status).toBe(400);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ ok: false, code: 'name_required' });
  });
});

describe('POST /api/games/join', () => {
  function join(body: unknown): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/api/games/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    });
  }

  it('joins a Game by its Join code (any case) as a Hider and sets the Seat cookie', async () => {
    const { game: created } = (await (await createGame()).json()) as { game: { id: string; roomCode: string } };

    const res = await join({ code: ` ${created.roomCode.toLowerCase()} `, name: 'Bo' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { game: { id: string; players: unknown[] }; playerId: string };
    expect(body.game.id).toBe(created.id);
    expect(body.game.players).toEqual([
      expect.objectContaining({ name: 'Ada', isHost: true }),
      { id: body.playerId, name: 'Bo', role: 'hider', ready: false, isHost: false },
    ]);
    expect(res.headers.get('Set-Cookie')).toMatch(
      new RegExp(`^seat=[\\w-]{16,}; HttpOnly; Secure; SameSite=Strict; Path=/ws/games/${created.id}$`),
    );
  });

  it.each([
    ['an unknown Join code', { code: 'ZZZZ', name: 'Bo' }],
    ['a malformed Join code', { code: 'not a code', name: 'Bo' }],
    ['no Join code', { name: 'Bo' }],
  ])('rejects %s with 404', async (_label, body) => {
    const res = await join(body);

    expect(res.status).toBe(404);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ ok: false, code: 'game_not_found' });
  });

  it('rejects a blank name with 400', async () => {
    const { game } = (await (await createGame()).json()) as { game: { roomCode: string } };

    const res = await join({ code: game.roomCode, name: ' ' });

    expect(res.status).toBe(400);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ ok: false, code: 'name_required' });
  });
});

describe('DELETE /api/games/:gameId/seat', () => {
  it("clears the Seat cookie on the Game's socket path", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/games/abc123/seat`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toBe(
      'seat=; HttpOnly; Secure; SameSite=Strict; Path=/ws/games/abc123; Max-Age=0',
    );
  });
});

describe('GET /ws/games/:gameId origin check', () => {
  const upgrade = (url: string, origin?: string) =>
    new Request(url, {
      headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) },
    }) as Request<unknown, IncomingRequestCfProperties>;

  it('requires a WebSocket upgrade', async () => {
    const res = await SELF.fetch(`${ORIGIN}/ws/games/abc?v=${PROTOCOL_VERSION}`, { headers: { Origin: ORIGIN } });

    expect(res.status).toBe(426);
  });

  it.each([
    ['a foreign Origin', 'https://evil.example'],
    ['the same host on another port', 'https://manhunt.example:8443'],
    ['no Origin', undefined],
  ])('rejects %s with 403 before reaching the Game', async (_label, origin) => {
    const res = await SELF.fetch(upgrade(`${ORIGIN}/ws/games/abc?v=${PROTOCOL_VERSION}`, origin));

    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it('accepts an Origin whose host matches behind a proxy that terminates TLS', async () => {
    const res = await worker.fetch(upgrade(`http://manhunt.example/ws/games/abc?v=1`, ORIGIN), env);

    // Past the Origin check, the missing Seat cookie is what rejects it.
    expect(res.status).toBe(101);
    res.webSocket?.accept();
  });

  it('accepts the PUBLIC_ORIGIN instead of the Host when it is set', async () => {
    const withPublicOrigin = { ...env, PUBLIC_ORIGIN: ORIGIN };
    const internal = 'http://app:8080/ws/games/abc?v=1';

    const allowed = await worker.fetch(upgrade(internal, ORIGIN), withPublicOrigin);
    const hostOrigin = await worker.fetch(upgrade(internal, 'http://app:8080'), withPublicOrigin);

    // Past the Origin check, the missing Seat cookie is what rejects it.
    expect(allowed.status).toBe(101);
    allowed.webSocket?.accept();
    expect(hostOrigin.status).toBe(403);
  });
});
