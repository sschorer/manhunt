import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useLobby } from './useLobby.ts';
import type { Game } from './types.ts';

function baseGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    roomCode: 'AB2C',
    status: 'active',
    players: [
      { id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true },
      { id: 'p2', name: 'Rui', role: 'hider', ready: true, isHost: false },
    ],
    createdAt: '2026-07-21T00:00:00.000Z',
    startedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

/** A fake socket with per-event acks and hand-driven lifecycle events. */
function fakeSocket() {
  const handlers = new Map<string, (arg?: unknown) => void>();
  const acks = new Map<string, unknown>();
  const socket = {
    emit: vi.fn(),
    emitWithAck: vi.fn((event: string) => Promise.resolve(acks.get(event))),
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers.set(event, cb);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
  };
  return {
    socket: socket as unknown as Socket & { emitWithAck: ReturnType<typeof vi.fn> },
    setAck(event: string, value: unknown) {
      acks.set(event, value);
    },
    fire(event: string, arg?: unknown) {
      act(() => handlers.get(event)?.(arg));
    },
  };
}

afterEach(() => cleanup());

describe('useLobby reconnect handling', () => {
  it('does not resume before a room has been joined', () => {
    const fake = fakeSocket();
    renderHook(() => useLobby(fake.socket));
    fake.fire('connect');
    expect(fake.socket.emitWithAck).not.toHaveBeenCalledWith('resume', expect.anything());
  });

  it('resumes the membership and refreshes the roster on reconnect', async () => {
    const fake = fakeSocket();
    fake.setAck('create_game', { ok: true, game: baseGame(), playerId: 'p1' });
    const { result } = renderHook(() => useLobby(fake.socket));

    await act(async () => {
      await result.current.createGame('Ada');
    });
    expect(result.current.game?.id).toBe('g1');

    // While we were away the host reassigned — the resume ack carries the fresh
    // roster the hook should adopt.
    const refreshed = baseGame({
      players: [
        { id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true },
        { id: 'p3', name: 'Mo', role: 'hider', ready: true, isHost: false },
      ],
    });
    fake.setAck('resume', { ok: true, game: refreshed, playerId: 'p1' });

    fake.fire('connect');

    await waitFor(() => {
      expect(fake.socket.emitWithAck).toHaveBeenCalledWith('resume', {
        gameId: 'g1',
        playerId: 'p1',
      });
    });
    await waitFor(() => {
      expect(result.current.game?.players.map((p) => p.id)).toEqual(['p1', 'p3']);
    });
  });

  it('keeps the last-known room when a resume is rejected', async () => {
    const fake = fakeSocket();
    fake.setAck('create_game', { ok: true, game: baseGame(), playerId: 'p1' });
    const { result } = renderHook(() => useLobby(fake.socket));

    await act(async () => {
      await result.current.createGame('Ada');
    });

    // The slot was already released (grace elapsed): the resume fails, and we
    // hold the last-known room rather than yanking the player to the join screen.
    fake.setAck('resume', { ok: false, error: 'gone', code: 'player_not_found' });
    fake.fire('connect');

    await waitFor(() => {
      expect(fake.socket.emitWithAck).toHaveBeenCalledWith('resume', {
        gameId: 'g1',
        playerId: 'p1',
      });
    });
    expect(result.current.game?.id).toBe('g1');
  });
});
