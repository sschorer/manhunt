import { describe, expect, it } from 'vitest';
import { createGame, DEFAULT_GRACE_MS, MAX_CATCH_FIX_AGE_MS, restoreGame } from './game.ts';

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
              rules: { pingIntervalMs: 180_000, gameDurationMs: 1_800_000 },
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

describe('rules', () => {
  it('tells players the ping interval and game length the Game runs with', () => {
    const game = createGame(host, setup, { pingIntervalMs: 60_000, gameDurationMs: 600_000 });

    expect(game.lobby().rules).toEqual({ pingIntervalMs: 60_000, gameDurationMs: 600_000 });
  });
});

/** A Lobby with the Host (Ada, a Hunter) and Bo (a Hider), both ready. */
function readyLobby() {
  const game = twoSeatLobby();
  game.apply({ type: 'set_ready', playerId: 'p-host', requestId: 1, payload: { ready: true } }, CREATED_AT);
  game.apply({ type: 'set_ready', playerId: 'p-bo', requestId: 2, payload: { ready: true } }, CREATED_AT);
  return game;
}

const STARTED_AT = CREATED_AT + 60_000;

describe('start_game', () => {
  it('lets the Host start once everyone is ready, replies with the Game and tells everyone', () => {
    const game = readyLobby();

    const effects = game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);

    expect(game.lobby()).toMatchObject({ status: 'active', startedAt: new Date(STARTED_AT).toISOString() });
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'reply', requestId: 9, body: { ok: true, game: game.lobby(), playerId: 'p-host' } },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
    ]);
    expect(restoreGame(game.snapshot()).lobby()).toEqual(game.lobby());
  });

  it('refuses a player who is not the Host', () => {
    const game = readyLobby();

    expect(game.apply({ type: 'start_game', playerId: 'p-bo', requestId: 9, payload: {} }, STARTED_AT)).toEqual([
      { type: 'reply', requestId: 9, body: { ok: false, error: expect.any(String), code: 'not_host' } },
    ]);
    expect(game.lobby().status).toBe('lobby');
  });

  it('refuses to start while a player is not ready', () => {
    const game = twoSeatLobby();
    game.apply({ type: 'set_ready', playerId: 'p-host', requestId: 1, payload: { ready: true } }, CREATED_AT);

    expect(game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT)).toEqual([
      { type: 'reply', requestId: 9, body: { ok: false, error: expect.any(String), code: 'not_ready' } },
    ]);
  });

  it('refuses to start alone', () => {
    const game = createGame(host, setup);
    game.apply({ type: 'set_ready', playerId: 'p-host', requestId: 1, payload: { ready: true } }, CREATED_AT);

    expect(game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT)).toEqual([
      { type: 'reply', requestId: 9, body: { ok: false, error: expect.any(String), code: 'not_ready' } },
    ]);
  });

  it('refuses to start without both a Hunter and a Hider', () => {
    const game = readyLobby();
    game.apply({ type: 'set_role', playerId: 'p-bo', requestId: 3, payload: { role: 'hunter' } }, CREATED_AT);

    expect(game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT)).toEqual([
      { type: 'reply', requestId: 9, body: { ok: false, error: expect.any(String), code: 'not_ready' } },
    ]);
  });

  it('refuses a Game that has already started', () => {
    const game = readyLobby();
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);

    expect(game.apply({ type: 'start_game', playerId: 'p-host', requestId: 10, payload: {} }, STARTED_AT)).toEqual([
      { type: 'reply', requestId: 10, body: { ok: false, error: expect.any(String), code: 'already_started' } },
    ]);
  });
});

describe('position_update', () => {
  /** An active Game with the Host (Ada, a Hunter) and Bo (a Hider). */
  function activeGame() {
    const game = readyLobby();
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);
    return game;
  }

  function update(playerId: string, lat: number, lng: number, extra: Record<string, unknown> = {}) {
    return { type: 'position_update' as const, playerId, payload: { gameId: 'g1', playerId, lat, lng, ...extra } };
  }

  const at = (ms: number) => new Date(ms).toISOString();

  it("keeps a Hider's position and sends each side its own view", () => {
    const game = activeGame();
    const now = STARTED_AT + 1_000;

    const effects = game.apply(update('p-bo', 52.1, 4.3), now);

    const position = { lat: 52.1, lng: 4.3, recordedAt: at(now) };
    expect(effects).toEqual([
      { type: 'positionChanged', seat: 'p-bo', position },
      { type: 'send', to: { role: 'hunter' }, message: { t: 'game_state', d: { gameId: 'g1', positions: {} } } },
      { type: 'send', to: { role: 'hider' }, message: { t: 'game_state', d: { gameId: 'g1', positions: { 'p-bo': position } } } },
    ]);
    expect(game.positions()).toEqual({ 'p-bo': position });
  });

  it("shows a Hunter's position to both sides", () => {
    const game = activeGame();
    const now = STARTED_AT + 1_000;

    const effects = game.apply(update('p-host', 52.2, 4.4), now);

    const positions = { 'p-host': { lat: 52.2, lng: 4.4, recordedAt: at(now) } };
    expect(effects).toContainEqual({ type: 'send', to: { role: 'hunter' }, message: { t: 'game_state', d: { gameId: 'g1', positions } } });
    expect(effects).toContainEqual({ type: 'send', to: { role: 'hider' }, message: { t: 'game_state', d: { gameId: 'g1', positions } } });
  });

  it('never sends Hider coordinates to the Hunters', () => {
    const game = activeGame();
    const effects = [
      ...game.apply(update('p-bo', 52.1, 4.3), STARTED_AT + 1_000),
      ...game.apply(update('p-host', 52.2, 4.4), STARTED_AT + 2_000),
      ...game.apply(update('p-bo', 52.1001, 4.3001), STARTED_AT + 3_000),
    ];

    const hunterViews = effects.flatMap((effect) =>
      effect.type === 'send' && typeof effect.to === 'object' && 'role' in effect.to && effect.to.role === 'hunter'
        ? [effect.message]
        : [],
    );
    expect(hunterViews).toHaveLength(3);
    for (const message of hunterViews) {
      expect(JSON.stringify(message)).not.toContain('p-bo');
      expect(JSON.stringify(message)).not.toContain('52.1');
    }
  });

  it('rejects an implausible jump and keeps the last good position', () => {
    const game = activeGame();
    game.apply(update('p-bo', 52.1, 4.3), STARTED_AT + 1_000);

    // About 1.1 km in one second.
    expect(game.apply(update('p-bo', 52.11, 4.3), STARTED_AT + 2_000)).toEqual([]);

    expect(game.positions()['p-bo']).toMatchObject({ lat: 52.1, lng: 4.3 });
  });

  it('accepts fast but plausible movement', () => {
    const game = activeGame();
    game.apply(update('p-bo', 52.1, 4.3), STARTED_AT + 1_000);

    // About 111 m in one second: fast, but under 150 m/s.
    const effects = game.apply(update('p-bo', 52.101, 4.3), STARTED_AT + 2_000);

    expect(effects).toContainEqual(expect.objectContaining({ type: 'positionChanged', seat: 'p-bo' }));
    expect(game.positions()['p-bo']).toMatchObject({ lat: 52.101 });
  });

  it.each([
    ['another player', update('p-bo', 52.1, 4.3, { playerId: 'p-host' })],
    ['another Game', update('p-bo', 52.1, 4.3, { gameId: 'g2' })],
    ['coordinates out of range', update('p-bo', 91, 4.3)],
    ['a malformed payload', { type: 'position_update' as const, playerId: 'p-bo', payload: 'nope' }],
    ['a player without a Seat', update('p-gone', 52.1, 4.3)],
  ])('ignores an update for %s', (_label, command) => {
    const game = activeGame();

    expect(game.apply(command, STARTED_AT + 1_000)).toEqual([]);
    expect(game.positions()).toEqual({});
  });

  it('ignores updates before the Game starts', () => {
    const game = readyLobby();

    expect(game.apply(update('p-bo', 52.1, 4.3), CREATED_AT)).toEqual([]);
  });

  it('never writes positions into the snapshot', () => {
    const game = activeGame();

    game.apply(update('p-bo', 52.1, 4.3), STARTED_AT + 1_000);

    expect(JSON.stringify(game.snapshot())).not.toContain('52.1');
  });

  it('restores positions handed back by the host and checks new updates against them', () => {
    const game = activeGame();
    game.apply(update('p-bo', 52.1, 4.3), STARTED_AT + 1_000);

    const restored = restoreGame(game.snapshot(), {}, game.positions());

    expect(restored.positions()).toEqual(game.positions());
    expect(restored.apply(update('p-bo', 52.11, 4.3), STARTED_AT + 2_000)).toEqual([]);
    const effects = restored.apply(update('p-host', 52.2, 4.4), STARTED_AT + 2_000);
    expect(effects).toContainEqual({
      type: 'send',
      to: { role: 'hider' },
      message: {
        t: 'game_state',
        d: {
          gameId: 'g1',
          positions: {
            'p-bo': { lat: 52.1, lng: 4.3, recordedAt: at(STARTED_AT + 1_000) },
            'p-host': { lat: 52.2, lng: 4.4, recordedAt: at(STARTED_AT + 2_000) },
          },
        },
      },
    });
  });

  it('ignores restored positions for players without a Seat', () => {
    const game = activeGame();

    const restored = restoreGame(game.snapshot(), {}, { 'p-gone': { lat: 1, lng: 2, recordedAt: at(STARTED_AT) } });

    expect(restored.positions()).toEqual({});
  });

  it('forgets the position of a released Seat', () => {
    const game = activeGame();
    game.apply(update('p-bo', 52.1, 4.3), STARTED_AT + 1_000);
    game.apply({ type: 'seat_dropped', playerId: 'p-bo' }, STARTED_AT + 1_000);

    game.apply({ type: 'timers_due' }, STARTED_AT + 1_000 + DEFAULT_GRACE_MS);

    expect(game.positions()).toEqual({});
  });
});

describe('Boundary warnings and Elimination', () => {
  /** A tight Boundary at the origin, so a fix is unambiguously in or out. */
  const BOUNDARY = { center: { lat: 0, lng: 0 }, radiusM: 100 };
  const INSIDE = { lat: 0, lng: 0 };
  /** ~1.1 km north of the centre — comfortably outside the 100 m circle. */
  const OUTSIDE = { lat: 0.01, lng: 0 };

  /** An active Game with a Boundary, the Host (a Hunter) and Bo (a Hider). */
  function fencedGame() {
    const game = readyLobby();
    game.apply({ type: 'set_boundary', playerId: 'p-host', requestId: 6, payload: { boundary: BOUNDARY } }, CREATED_AT);
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);
    return game;
  }

  function fix(playerId: string, { lat, lng }: { lat: number; lng: number }) {
    return { type: 'position_update' as const, playerId, payload: { gameId: 'g1', playerId, lat, lng } };
  }

  const at = (ms: number) => new Date(ms).toISOString();

  it('warns the player who left the Boundary, and only them', () => {
    const game = fencedGame();
    const now = STARTED_AT + 1_000;

    const effects = game.apply(fix('p-bo', OUTSIDE), now);

    expect(effects).toContainEqual({
      type: 'send',
      to: { seat: 'p-bo' },
      message: {
        t: 'boundary_warning',
        d: {
          gameId: 'g1',
          playerId: 'p-bo',
          warnings: 1,
          warningsRemaining: 0,
          metersOutside: expect.closeTo(1012, 0),
          at: at(now),
        },
      },
    });
    expect(effects).toContainEqual({ type: 'durableChanged' });
    expect(game.lobby().players.map((p) => p.eliminated)).toEqual([undefined, undefined]);
  });

  it('eliminates a player who stays outside once their warning is used up, and tells everyone', () => {
    const game = fencedGame();
    game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 1_000);
    const now = STARTED_AT + 2_000;

    const effects = game.apply(fix('p-bo', OUTSIDE), now);

    expect(game.lobby().players.find((p) => p.id === 'p-bo')?.eliminated).toBe(true);
    expect(effects).toContainEqual({
      type: 'send',
      to: 'everyone',
      message: {
        t: 'player_eliminated',
        d: { gameId: 'g1', playerId: 'p-bo', reason: 'boundary', at: at(now) },
      },
    });
    expect(effects).toContainEqual({
      type: 'send',
      to: 'everyone',
      message: { t: 'lobby_update', d: { game: game.lobby() } },
    });
    // Out of play: their last position is dropped, so nobody is shown it again.
    expect(game.positions()).toEqual({});
    expect(effects).toContainEqual({
      type: 'send',
      to: { role: 'hider' },
      message: { t: 'game_state', d: { gameId: 'g1', positions: {} } },
    });
    expect(effects).not.toContainEqual(expect.objectContaining({ type: 'positionChanged' }));
  });

  it('forgives the warnings once the player is back inside the Boundary', () => {
    const game = fencedGame();
    game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 1_000);

    // 1.1 km back in 20 s is plausible, so the return is accepted.
    expect(game.apply(fix('p-bo', INSIDE), STARTED_AT + 21_000)).toContainEqual({ type: 'durableChanged' });

    // Leaving again starts a fresh excursion: another warning, not an Elimination.
    const effects = restoreGame(game.snapshot()).apply(fix('p-bo', OUTSIDE), STARTED_AT + 41_000);

    expect(effects).toContainEqual(
      expect.objectContaining({
        to: { seat: 'p-bo' },
        message: expect.objectContaining({
          t: 'boundary_warning',
          d: expect.objectContaining({ warnings: 1, warningsRemaining: 0 }),
        }),
      }),
    );
    expect(game.lobby().players.find((p) => p.id === 'p-bo')?.eliminated).toBeUndefined();
  });

  it('ignores whatever an eliminated player reports afterwards', () => {
    const game = fencedGame();
    game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 1_000);
    game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 2_000);

    expect(game.apply(fix('p-bo', INSIDE), STARTED_AT + 22_000)).toEqual([]);

    expect(game.positions()).toEqual({});
    expect(game.lobby().players.find((p) => p.id === 'p-bo')?.eliminated).toBe(true);
  });

  it('keeps the warnings and the Elimination across a restore', () => {
    const game = fencedGame();
    // The Host is warned once; Bo leaves twice and is eliminated.
    game.apply(fix('p-host', OUTSIDE), STARTED_AT + 1_000);
    game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 1_000);
    game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 2_000);
    // A host that still holds the eliminated player's last fix hands it back.
    const staleBo = { 'p-bo': { lat: OUTSIDE.lat, lng: OUTSIDE.lng, recordedAt: at(STARTED_AT + 1_000) } };

    const restored = restoreGame(game.snapshot(), {}, { ...game.positions(), ...staleBo });

    expect(restored.positions()).toEqual(game.positions());
    expect(restored.lobby().players.find((p) => p.id === 'p-bo')?.eliminated).toBe(true);
    expect(restored.apply(fix('p-bo', INSIDE), STARTED_AT + 22_000)).toEqual([]);
    // The Host's warning is remembered, so their next fix outside eliminates them.
    expect(restored.apply(fix('p-host', OUTSIDE), STARTED_AT + 22_000)).toContainEqual(
      expect.objectContaining({
        to: 'everyone',
        message: expect.objectContaining({
          t: 'player_eliminated',
          d: expect.objectContaining({ playerId: 'p-host', reason: 'boundary' }),
        }),
      }),
    );
  });

  it('never warns a player who stays inside the Boundary', () => {
    const game = fencedGame();

    const effects = game.apply(fix('p-bo', INSIDE), STARTED_AT + 1_000);

    expect(effects).not.toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ t: 'boundary_warning' }) }),
    );
    expect(effects).not.toContainEqual({ type: 'durableChanged' });
  });

  it('enforces nothing in a Game without a Boundary', () => {
    const game = readyLobby();
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);

    const effects = game.apply(fix('p-bo', OUTSIDE), STARTED_AT + 1_000);

    expect(effects).toContainEqual(expect.objectContaining({ type: 'positionChanged', seat: 'p-bo' }));
    expect(effects).not.toContainEqual({ type: 'durableChanged' });
  });
});

describe('claim_catch', () => {
  /** The anchor both players are placed around. */
  const BASE = { lat: 0, lng: 0 };
  /** ~5.6 m north of the anchor — well inside the 15 m Catch radius. */
  const NEAR = { lat: 0.00005, lng: 0 };
  /** ~1.1 km north of the anchor — well outside it. */
  const FAR = { lat: 0.01, lng: 0 };

  const FIXED_AT = STARTED_AT + 1_000;
  const CLAIMED_AT = FIXED_AT + 1_000;

  function fix(playerId: string, { lat, lng }: { lat: number; lng: number }) {
    return { type: 'position_update' as const, playerId, payload: { gameId: 'g1', playerId, lat, lng } };
  }

  function claim(targetId: string, playerId = 'p-host', payload?: unknown) {
    return {
      type: 'claim_catch' as const,
      playerId,
      requestId: 7,
      payload: payload ?? { gameId: 'g1', hunterId: playerId, targetId },
    };
  }

  /** An active Game where the Host (a Hunter) and Bo (a Hider) have both reported a fix. */
  function placedGame(hiderAt: { lat: number; lng: number } = NEAR) {
    const game = readyLobby();
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);
    game.apply(fix('p-host', BASE), FIXED_AT);
    game.apply(fix('p-bo', hiderAt), FIXED_AT);
    return game;
  }

  const rejection = (code: string) =>
    expect.objectContaining({
      type: 'reply',
      requestId: 7,
      body: expect.objectContaining({ ok: false, code }),
    });

  it('confirms a Catch in range, turns the Hider into a Hunter and tells everyone', () => {
    const game = placedGame();

    const effects = game.apply(claim('p-bo'), CLAIMED_AT);

    const confirmed = {
      gameId: 'g1',
      hunterId: 'p-host',
      targetId: 'p-bo',
      at: new Date(CLAIMED_AT).toISOString(),
    };
    expect(game.lobby().players.map((p) => p.role)).toEqual(['hunter', 'hunter']);
    // Both are Hunters now, so both sides see both positions.
    const positions = {
      'p-host': { ...BASE, recordedAt: new Date(FIXED_AT).toISOString() },
      'p-bo': { ...NEAR, recordedAt: new Date(FIXED_AT).toISOString() },
    };
    expect(effects).toEqual([
      { type: 'durableChanged' },
      { type: 'reply', requestId: 7, body: { ok: true, catch: confirmed } },
      { type: 'send', to: 'everyone', message: { t: 'catch_confirmed', d: confirmed } },
      { type: 'send', to: 'everyone', message: { t: 'lobby_update', d: { game: game.lobby() } } },
      { type: 'send', to: { role: 'hunter' }, message: { t: 'game_state', d: { gameId: 'g1', positions } } },
      { type: 'send', to: { role: 'hider' }, message: { t: 'game_state', d: { gameId: 'g1', positions } } },
    ]);
  });

  it('records the Catch in the snapshot, which survives a restore', () => {
    const game = placedGame();
    game.apply(claim('p-bo'), CLAIMED_AT);

    const restored = restoreGame(JSON.parse(JSON.stringify(game.snapshot())));

    expect(restored.snapshot().catches).toEqual([
      { hunterId: 'p-host', targetId: 'p-bo', at: new Date(CLAIMED_AT).toISOString() },
    ]);
    expect(restored.lobby().players.find((p) => p.id === 'p-bo')?.role).toBe('hunter');
  });

  it('rejects a claim on a Hider outside the Catch radius and changes nothing', () => {
    const game = placedGame(FAR);

    expect(game.apply(claim('p-bo'), CLAIMED_AT)).toEqual([rejection('out_of_range')]);
    expect(game.lobby().players.find((p) => p.id === 'p-bo')?.role).toBe('hider');
    expect(game.snapshot().catches ?? []).toEqual([]);
  });

  it('rejects a claim from a player who is not a Hunter', () => {
    const game = placedGame();

    expect(game.apply(claim('p-host', 'p-bo'), CLAIMED_AT)).toEqual([rejection('not_hunter')]);
    expect(game.lobby().players.map((p) => p.role)).toEqual(['hunter', 'hider']);
  });

  it('rejects a claim on a player who is not a Hider', () => {
    const game = placedGame();
    game.apply(claim('p-bo'), CLAIMED_AT);

    // Bo is a Hunter now: catching them again is not a Catch.
    expect(game.apply(claim('p-bo'), CLAIMED_AT + 1_000)).toEqual([rejection('not_hider')]);
    expect(game.snapshot().catches).toHaveLength(1);
  });

  it('rejects a claim on a Hider who is out of play', () => {
    const game = readyLobby();
    game.apply(
      { type: 'set_boundary', playerId: 'p-host', requestId: 6, payload: { boundary: { center: BASE, radiusM: 100 } } },
      CREATED_AT,
    );
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);
    game.apply(fix('p-host', BASE), FIXED_AT);
    game.apply(fix('p-bo', FAR), FIXED_AT);
    game.apply(fix('p-bo', FAR), FIXED_AT + 1_000);

    expect(game.lobby().players.find((p) => p.id === 'p-bo')?.eliminated).toBe(true);
    expect(game.apply(claim('p-bo'), CLAIMED_AT)).toEqual([rejection('not_hider')]);
  });

  it('rejects a claim measured against a stale fix', () => {
    const game = placedGame();

    const effects = game.apply(claim('p-bo'), FIXED_AT + MAX_CATCH_FIX_AGE_MS + 1);

    expect(effects).toEqual([rejection('stale_position')]);
    expect(game.lobby().players.find((p) => p.id === 'p-bo')?.role).toBe('hider');
  });

  it('confirms a Catch on a fix that is old but not yet stale', () => {
    const game = placedGame();

    const effects = game.apply(claim('p-bo'), FIXED_AT + MAX_CATCH_FIX_AGE_MS);

    expect(effects).toContainEqual(expect.objectContaining({ type: 'reply', body: expect.objectContaining({ ok: true }) }));
  });

  it('rejects a claim before either player has reported a position', () => {
    const game = readyLobby();
    game.apply({ type: 'start_game', playerId: 'p-host', requestId: 9, payload: {} }, STARTED_AT);

    expect(game.apply(claim('p-bo'), CLAIMED_AT)).toEqual([rejection('no_position')]);
  });

  it('rejects a claim while the Game has not started', () => {
    const game = readyLobby();

    expect(game.apply(claim('p-bo'), CLAIMED_AT)).toEqual([rejection('not_active')]);
  });

  it.each([
    ['a malformed payload', 'nope', 'invalid_payload'],
    ['a missing target', { gameId: 'g1', hunterId: 'p-host' }, 'target_id_required'],
    ['a Catch on themselves', { gameId: 'g1', hunterId: 'p-host', targetId: 'p-host' }, 'self_catch'],
    ['another Game', { gameId: 'g2', hunterId: 'p-host', targetId: 'p-bo' }, 'invalid_payload'],
    ['another player as the Hunter', { gameId: 'g1', hunterId: 'p-bo', targetId: 'p-host' }, 'invalid_payload'],
  ])('rejects %s', (_label, payload, code) => {
    const game = placedGame();

    expect(game.apply(claim('p-bo', 'p-host', payload), CLAIMED_AT)).toEqual([rejection(code)]);
  });

  it('rejects a claim on a player who has no Seat', () => {
    const game = placedGame();

    expect(game.apply(claim('p-gone'), CLAIMED_AT)).toEqual([rejection('not_hider')]);
  });
});
