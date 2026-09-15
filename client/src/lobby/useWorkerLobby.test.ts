import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Game, OutboundEventMap } from '@manhunt/shared';
import { RequestError, type GameConnection } from '../transport/gameConnection.ts';
import { useWorkerLobby } from './useWorkerLobby.ts';

const game: Game = {
  id: 'g1',
  roomCode: 'AB2C',
  status: 'lobby',
  createdAt: '2026-09-13T10:00:00.000Z',
  players: [{ id: 'p1', name: 'Ada', role: 'hunter', ready: false, isHost: true }],
};

/** A connection the test drives: it records requests and emits events on command. */
function fakeConnection() {
  const listeners = new Map<string, (payload: unknown) => void>();
  let closeListener: ((code: number) => void) | undefined;
  const connection = {
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    onClose: vi.fn((listener: (code: number) => void) => {
      closeListener = listener;
      return () => {
        closeListener = undefined;
      };
    }),
    request: vi.fn(() => Promise.resolve<unknown>({ ok: true })),
    close: vi.fn(),
  };
  return {
    connection: connection as unknown as GameConnection & typeof connection,
    emit<K extends keyof OutboundEventMap>(name: K, payload: OutboundEventMap[K]) {
      act(() => listeners.get(name)?.(payload));
    },
    serverClose(code: number) {
      act(() => closeListener?.(code));
    },
  };
}

function created(body: unknown = { game, playerId: 'p1' }, status = 201) {
  return vi.fn(() => Promise.resolve(Response.json(body, { status })));
}

async function createdLobby(fetch = created()) {
  const fake = fakeConnection();
  const connect = vi.fn(() => fake.connection);
  const hook = renderHook(() => useWorkerLobby({ fetch, connect }));
  await act(() => hook.result.current.createGame('Ada'));
  return { ...hook, fake, connect, fetch };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('useWorkerLobby', () => {
  it("creates a Game over HTTP, then opens that Game's socket", async () => {
    const { result, fetch, connect } = await createdLobby();

    expect(fetch).toHaveBeenCalledWith('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(result.current.game).toEqual(game);
    expect(result.current.playerId).toBe('p1');
    expect(result.current.pending).toBe(false);
    expect(connect).toHaveBeenCalledWith('g1');
  });

  it('follows the Lobby snapshots the Game sends', async () => {
    const { result, fake } = await createdLobby();
    const updated = { ...game, players: [{ ...game.players[0]!, ready: true }] };

    fake.emit('lobby_update', { game: updated });

    expect(result.current.game).toEqual(updated);
  });

  it('ignores snapshots for another Game', async () => {
    const { result, fake } = await createdLobby();

    fake.emit('lobby_update', { game: { ...game, id: 'other' } });

    expect(result.current.game).toEqual(game);
  });

  it('shows the error the server gives for a rejected create', async () => {
    const { result, connect } = await createdLobby(
      created({ ok: false, error: 'A name is required', code: 'name_required' }, 400),
    );

    expect(result.current.game).toBeNull();
    expect(result.current.error).toBe('A name is required');
    expect(connect).not.toHaveBeenCalled();
  });

  it('shows a connection error when the server cannot be reached', async () => {
    const { result } = await createdLobby(vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    expect(result.current.game).toBeNull();
    expect(result.current.error).toMatch(/could not reach the server/i);
  });

  it('sends Lobby actions as requests and shows a rejected reply', async () => {
    const { result, fake } = await createdLobby();
    fake.connection.request.mockResolvedValueOnce({ ok: false, error: 'Not available yet', code: 'unsupported' });

    act(() => result.current.setReady(true));

    expect(fake.connection.request).toHaveBeenCalledWith('set_ready', { ready: true });
    await waitFor(() => expect(result.current.error).toBe('Not available yet'));
  });

  it('shows a connection error when a request fails without a reply', async () => {
    const { result, fake } = await createdLobby();
    fake.connection.request.mockRejectedValueOnce(new RequestError('disconnected'));

    act(() => result.current.startGame());

    await waitFor(() => expect(result.current.error).toMatch(/could not reach the server/i));
  });

  it('goes back to the join screen when the Game rejects the Seat', async () => {
    const { result, fake } = await createdLobby();

    fake.serverClose(4001);

    expect(result.current.game).toBeNull();
    expect(result.current.playerId).toBeNull();
    expect(fake.connection.close).toHaveBeenCalled();
  });

  it('joins a Game by its Join code over HTTP, then opens its socket', async () => {
    const fake = fakeConnection();
    const connect = vi.fn(() => fake.connection);
    const fetch = created({ game, playerId: 'p2' }, 200);
    const { result } = renderHook(() => useWorkerLobby({ fetch, connect }));

    await act(() => result.current.joinGame('AB2C', 'Bo'));

    expect(fetch).toHaveBeenCalledWith('/api/games/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'AB2C', name: 'Bo' }),
    });
    expect(result.current.game).toEqual(game);
    expect(result.current.playerId).toBe('p2');
    expect(connect).toHaveBeenCalledWith('g1');
  });

  it('shows the error the server gives for a rejected join', async () => {
    const connect = vi.fn();
    const fetch = created({ ok: false, error: 'No Game with that Join code', code: 'game_not_found' }, 404);
    const { result } = renderHook(() => useWorkerLobby({ fetch, connect }));

    await act(() => result.current.joinGame('ZZZZ', 'Bo'));

    expect(result.current.game).toBeNull();
    expect(result.current.error).toBe('No Game with that Join code');
    expect(connect).not.toHaveBeenCalled();
  });

  it('reconnects to the remembered Seat after a reload', async () => {
    const first = await createdLobby();
    first.unmount();

    const fake = fakeConnection();
    const connect = vi.fn(() => fake.connection);
    const { result } = renderHook(() => useWorkerLobby({ fetch: created(), connect }));

    expect(connect).toHaveBeenCalledWith('g1');
    expect(result.current.playerId).toBe('p1');
    fake.emit('lobby_update', { game });
    expect(result.current.game).toEqual(game);
  });

  it('forgets the remembered Seat when the Game rejects it', async () => {
    const { fake } = await createdLobby();

    fake.serverClose(4001);

    const fresh = fakeConnection();
    const connect = vi.fn(() => fresh.connection);
    renderHook(() => useWorkerLobby({ fetch: created(), connect }));
    expect(connect).not.toHaveBeenCalled();
  });

  it('goes back to the join screen with a message when another tab takes the Seat', async () => {
    const { result, fake } = await createdLobby();

    fake.serverClose(4003);

    expect(result.current.game).toBeNull();
    expect(result.current.error).toMatch(/another tab/i);
  });

  it('leaves with a request, then clears the Seat cookie and forgets the Seat', async () => {
    const { result, fake, fetch } = await createdLobby();

    act(() => result.current.leave());

    expect(result.current.game).toBeNull();
    expect(fake.connection.request).toHaveBeenCalledWith('leave_game', undefined);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/games/g1/seat', { method: 'DELETE' }));
    expect(fake.connection.close).toHaveBeenCalled();

    const connect = vi.fn();
    renderHook(() => useWorkerLobby({ fetch: created(), connect }));
    expect(connect).not.toHaveBeenCalled();
  });

  it('still clears the Seat cookie when the leave request fails', async () => {
    const { result, fake, fetch } = await createdLobby();
    fake.connection.request.mockRejectedValueOnce(new RequestError('disconnected'));

    act(() => result.current.leave());

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/games/g1/seat', { method: 'DELETE' }));
    expect(fake.connection.close).toHaveBeenCalled();
  });

  it('closes the socket on unmount', async () => {
    const { unmount, fake } = await createdLobby();

    unmount();

    expect(fake.connection.close).toHaveBeenCalled();
  });
});
