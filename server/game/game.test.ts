import { describe, expect, it } from 'vitest';
import { createGame, restoreGame } from './game.ts';

const CREATED_AT = Date.parse('2026-09-13T10:00:00.000Z');
const host = { playerId: 'p-host', name: 'Ada', token: 'token-host' };
const setup = { gameId: 'g1', joinCode: 'AB2C', now: CREATED_AT };

describe('createGame', () => {
  it('opens a Lobby with its Join code and seats the Host as a Hunter who is not ready', () => {
    const game = createGame(host, setup);

    expect(game.apply({ type: 'seat_reconnected', playerId: 'p-host' }, CREATED_AT)).toEqual([
      {
        type: 'send',
        to: { seat: 'p-host' },
        message: {
          t: 'lobby_update',
          d: {
            game: {
              id: 'g1',
              roomCode: 'AB2C',
              status: 'lobby',
              createdAt: '2026-09-13T10:00:00.000Z',
              players: [{ id: 'p-host', name: 'Ada', role: 'hunter', ready: false, isHost: true }],
            },
          },
        },
      },
    ]);
  });

  it('trims the Host name and caps it at 24 characters', () => {
    const game = createGame({ ...host, name: `  ${'x'.repeat(30)}  ` }, setup);

    expect(game.snapshot().seats[0]?.name).toBe('x'.repeat(24));
  });

  it.each([undefined, '', '   ', 42])('requires a Host name: %o', (name) => {
    expect(() => createGame({ ...host, name }, setup)).toThrow(
      expect.objectContaining({ code: 'name_required' }),
    );
  });

  it('finds a Seat by its resume token and nothing for a foreign token', () => {
    const game = createGame(host, setup);

    expect(game.seatFor('token-host')).toBe('p-host');
    expect(game.seatFor('token-other')).toBeUndefined();
  });

  it('closes a socket for a Seat the Game does not hold with 4001', () => {
    const game = createGame(host, setup);

    expect(game.apply({ type: 'seat_reconnected', playerId: 'p-gone' }, CREATED_AT)).toEqual([
      { type: 'close', seat: 'p-gone', code: 4001 },
    ]);
  });
});

describe('join', () => {
  it('seats a player as a Hider who is not ready and tells everyone', () => {
    const game = createGame(host, setup);

    const effects = game.apply({ type: 'join', playerId: 'p-bo', name: ' Bo ', token: 'token-bo' }, CREATED_AT);

    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
    ]);
    expect(game.lobby().players).toEqual([
      { id: 'p-host', name: 'Ada', role: 'hunter', ready: false, isHost: true },
      { id: 'p-bo', name: 'Bo', role: 'hider', ready: false, isHost: false },
    ]);
    expect(game.seatFor('token-bo')).toBe('p-bo');
  });

  it('requires a name', () => {
    const game = createGame(host, setup);

    expect(() => game.apply({ type: 'join', playerId: 'p-bo', name: ' ', token: 't' }, CREATED_AT)).toThrow(
      expect.objectContaining({ code: 'name_required' }),
    );
    expect(game.lobby().players).toHaveLength(1);
  });

  it('refuses a Game that has already started', () => {
    const game = restoreGame({ ...createGame(host, setup).snapshot(), status: 'active' });

    expect(() => game.apply({ type: 'join', playerId: 'p-bo', name: 'Bo', token: 't' }, CREATED_AT)).toThrow(
      expect.objectContaining({ code: 'already_started' }),
    );
  });
});

/** A Lobby with the Host (Ada) and a joined Hider (Bo). */
function twoSeatLobby() {
  const game = createGame(host, setup);
  game.apply({ type: 'join', playerId: 'p-bo', name: 'Bo', token: 'token-bo' }, CREATED_AT);
  return game;
}

describe('set_role', () => {
  it("switches the caller's side, replies with the Lobby and tells everyone", () => {
    const game = twoSeatLobby();

    const effects = game.apply({ type: 'set_role', playerId: 'p-bo', requestId: 3, payload: { role: 'hunter' } }, CREATED_AT);

    expect(game.lobby().players.map((p) => p.role)).toEqual(['hunter', 'hunter']);
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'reply', requestId: 3, body: { ok: true, game: game.lobby(), playerId: 'p-bo' } },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
    ]);
  });

  it.each([undefined, {}, { role: 'seeker' }])('rejects an unknown role: %o', (payload) => {
    const game = twoSeatLobby();

    const effects = game.apply({ type: 'set_role', playerId: 'p-bo', requestId: 3, payload }, CREATED_AT);

    expect(effects).toEqual([
      { type: 'reply', requestId: 3, body: { ok: false, error: expect.any(String), code: 'invalid_role' } },
    ]);
    expect(game.lobby().players[1]?.role).toBe('hider');
  });

  it('rejects a caller without a Seat', () => {
    const game = twoSeatLobby();

    const effects = game.apply({ type: 'set_role', playerId: 'p-gone', requestId: 3, payload: { role: 'hider' } }, CREATED_AT);

    expect(effects).toEqual([
      { type: 'reply', requestId: 3, body: { ok: false, error: expect.any(String), code: 'player_not_found' } },
    ]);
  });

  it('rejects a change once the Game has started', () => {
    const game = restoreGame({ ...twoSeatLobby().snapshot(), status: 'active' });

    const effects = game.apply({ type: 'set_role', playerId: 'p-bo', requestId: 3, payload: { role: 'hunter' } }, CREATED_AT);

    expect(effects).toEqual([
      { type: 'reply', requestId: 3, body: { ok: false, error: expect.any(String), code: 'already_started' } },
    ]);
  });
});

describe('set_ready', () => {
  it("sets the caller's readiness, replies with the Lobby and tells everyone", () => {
    const game = twoSeatLobby();

    const effects = game.apply({ type: 'set_ready', playerId: 'p-bo', requestId: 4, payload: { ready: true } }, CREATED_AT);

    expect(game.lobby().players.map((p) => p.ready)).toEqual([false, true]);
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'reply', requestId: 4, body: { ok: true, game: game.lobby(), playerId: 'p-bo' } },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
    ]);

    game.apply({ type: 'set_ready', playerId: 'p-bo', requestId: 5, payload: { ready: false } }, CREATED_AT);
    expect(game.lobby().players[1]?.ready).toBe(false);
  });

  it.each([undefined, {}, { ready: 'yes' }])('rejects a readiness that is not a boolean: %o', (payload) => {
    const game = twoSeatLobby();

    expect(game.apply({ type: 'set_ready', playerId: 'p-bo', requestId: 4, payload }, CREATED_AT)).toEqual([
      { type: 'reply', requestId: 4, body: { ok: false, error: expect.any(String), code: 'invalid_payload' } },
    ]);
  });
});

describe('set_boundary', () => {
  const boundary = { center: { lat: 52.37, lng: 4.9 }, radiusM: 500 };

  it('lets the Host set the Boundary, which everyone sees in the Lobby', () => {
    const game = twoSeatLobby();

    const effects = game.apply({ type: 'set_boundary', playerId: 'p-host', requestId: 6, payload: { boundary } }, CREATED_AT);

    expect(game.lobby().boundary).toEqual(boundary);
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'reply', requestId: 6, body: { ok: true, game: game.lobby(), playerId: 'p-host' } },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
    ]);
    expect(restoreGame(game.snapshot()).lobby().boundary).toEqual(boundary);
  });

  it('refuses a player who is not the Host', () => {
    const game = twoSeatLobby();

    expect(game.apply({ type: 'set_boundary', playerId: 'p-bo', requestId: 6, payload: { boundary } }, CREATED_AT)).toEqual([
      { type: 'reply', requestId: 6, body: { ok: false, error: expect.any(String), code: 'not_host' } },
    ]);
    expect(game.lobby().boundary).toBeUndefined();
  });

  it('rejects an invalid Boundary with the validator code', () => {
    const game = twoSeatLobby();
    const payload = { boundary: { ...boundary, radiusM: 0 } };

    expect(game.apply({ type: 'set_boundary', playerId: 'p-host', requestId: 6, payload }, CREATED_AT)).toEqual([
      { type: 'reply', requestId: 6, body: { ok: false, error: expect.any(String), code: 'invalid_radius' } },
    ]);
  });
});

describe('leave_game', () => {
  it('releases the Seat, replies ok, tells everyone and closes the Seat with 4001', () => {
    const game = twoSeatLobby();

    const effects = game.apply({ type: 'leave_game', playerId: 'p-bo', requestId: 8, payload: undefined }, CREATED_AT);

    expect(game.lobby().players.map((p) => p.id)).toEqual(['p-host']);
    expect(game.seatFor('token-bo')).toBeUndefined();
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'reply', requestId: 8, body: { ok: true } },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
      { type: 'close', seat: 'p-bo', code: 4001 },
    ]);
  });

  it('hands the Host role to the next player when the Host leaves', () => {
    const game = twoSeatLobby();

    game.apply({ type: 'leave_game', playerId: 'p-host', requestId: 8, payload: undefined }, CREATED_AT);

    expect(game.lobby().players).toEqual([{ id: 'p-bo', name: 'Bo', role: 'hider', ready: false, isHost: true }]);
  });

  it('rejects a caller without a Seat', () => {
    const game = twoSeatLobby();

    expect(game.apply({ type: 'leave_game', playerId: 'p-gone', requestId: 8, payload: undefined }, CREATED_AT)).toEqual([
      { type: 'reply', requestId: 8, body: { ok: false, error: expect.any(String), code: 'player_not_found' } },
    ]);
  });
});

describe('Grace period in the Lobby', () => {
  const graceMs = 30_000;
  const dropped = CREATED_AT + 5_000;

  function droppedBo() {
    const game = twoSeatLobby();
    const effects = game.apply({ type: 'seat_dropped', playerId: 'p-bo' }, dropped);
    return { game, effects };
  }

  it('holds a dropped Seat until its Grace period deadline', () => {
    const { game, effects } = droppedBo();

    expect(effects).toEqual([{ type: 'durableChanged' }]);
    expect(game.nextDeadline()).toBe(dropped + graceMs);
    expect(game.lobby().players.map((p) => p.id)).toEqual(['p-host', 'p-bo']);
    expect(game.apply({ type: 'timers_due' }, dropped + graceMs - 1)).toEqual([]);
  });

  it('keeps the Seat when it reconnects within the Grace period', () => {
    const { game } = droppedBo();

    const effects = game.apply({ type: 'seat_reconnected', playerId: 'p-bo' }, dropped + graceMs - 1);

    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'send', to: { seat: 'p-bo' }, message: { t: 'lobby_update', d: { game: game.lobby() } } },
    ]);
    expect(game.nextDeadline()).toBeNull();
    expect(game.apply({ type: 'timers_due' }, dropped + graceMs)).toEqual([]);
  });

  it('releases the Seat once the Grace period passes and tells everyone', () => {
    const { game } = droppedBo();

    const effects = game.apply({ type: 'timers_due' }, dropped + graceMs);

    expect(game.lobby().players.map((p) => p.id)).toEqual(['p-host']);
    expect(game.nextDeadline()).toBeNull();
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
      { type: 'close', seat: 'p-bo', code: 4001 },
    ]);
  });

  it('hands the Host role on when the Host is released', () => {
    const game = twoSeatLobby();
    game.apply({ type: 'seat_dropped', playerId: 'p-host' }, dropped);

    game.apply({ type: 'timers_due' }, dropped + graceMs);

    expect(game.lobby().players).toEqual([{ id: 'p-bo', name: 'Bo', role: 'hider', ready: false, isHost: true }]);
  });

  it('keeps the earliest deadline first when several Seats drop', () => {
    const game = twoSeatLobby();
    game.apply({ type: 'seat_dropped', playerId: 'p-bo' }, dropped + 1_000);
    game.apply({ type: 'seat_dropped', playerId: 'p-host' }, dropped);

    expect(game.nextDeadline()).toBe(dropped + graceMs);
    game.apply({ type: 'timers_due' }, dropped + graceMs);
    expect(game.nextDeadline()).toBe(dropped + 1_000 + graceMs);
  });

  it('keeps the deadline across a restore', () => {
    const { game } = droppedBo();

    expect(restoreGame(game.snapshot()).nextDeadline()).toBe(dropped + graceMs);
  });

  it('uses the configured Grace period', () => {
    const game = createGame(host, setup, { graceMs: 1_000 });

    game.apply({ type: 'seat_dropped', playerId: 'p-host' }, dropped);

    expect(game.nextDeadline()).toBe(dropped + 1_000);
    expect(restoreGame(game.snapshot(), { graceMs: 5_000 }).nextDeadline()).toBe(dropped + 1_000);
  });

  it('ignores a drop for a Seat the Game does not hold', () => {
    const game = twoSeatLobby();

    expect(game.apply({ type: 'seat_dropped', playerId: 'p-gone' }, dropped)).toEqual([]);
    expect(game.nextDeadline()).toBeNull();
  });
});

describe('restoreGame', () => {
  it('restores the same Lobby from a snapshot that went through JSON', () => {
    const created = createGame(host, setup);
    const stored = JSON.parse(JSON.stringify(created.snapshot())) as unknown;

    const restored = restoreGame(stored);

    expect(restored.snapshot()).toEqual(created.snapshot());
    expect(restored.seatFor('token-host')).toBe('p-host');
    expect(restored.apply({ type: 'seat_reconnected', playerId: 'p-host' }, CREATED_AT + 1000)).toEqual(
      created.apply({ type: 'seat_reconnected', playerId: 'p-host' }, CREATED_AT),
    );
  });

  it('does not share state with the snapshot it was restored from', () => {
    const snapshot = createGame(host, setup).snapshot();
    const restored = restoreGame(snapshot);

    snapshot.seats[0]!.name = 'Mallory';

    expect(restored.snapshot().seats[0]?.name).toBe('Ada');
  });

  it.each([null, {}, { version: 99 }])('rejects an unknown snapshot version: %o', (snapshot) => {
    expect(() => restoreGame(snapshot)).toThrow(
      expect.objectContaining({ code: 'unsupported_snapshot' }),
    );
  });
});
