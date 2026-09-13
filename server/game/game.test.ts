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
