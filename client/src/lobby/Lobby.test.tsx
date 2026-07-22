import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Socket } from 'socket.io-client';
import Lobby from './Lobby.tsx';
import type { Game, LobbyAck } from './types.ts';

/**
 * A fake Socket.IO client: `emitWithAck` is answered by a per-event responder
 * the test installs, and `push` lets a test drive an inbound `lobby_update`.
 */
function makeFakeSocket() {
  const handlers: Record<string, Array<(payload: unknown) => void>> = {};
  let responder: (event: string, payload: unknown) => LobbyAck | Promise<LobbyAck> = () => ({
    ok: false,
    error: 'no responder',
  });

  const emitWithAck = vi.fn((event: string, payload: unknown) =>
    Promise.resolve(responder(event, payload)),
  );

  const socket = {
    on(event: string, cb: (payload: unknown) => void) {
      (handlers[event] ||= []).push(cb);
    },
    off(event: string, cb: (payload: unknown) => void) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== cb);
    },
    emit: vi.fn(),
    emitWithAck,
  } as unknown as Socket;

  return {
    socket,
    emitWithAck,
    setResponder(fn: typeof responder) {
      responder = fn;
    },
    push(event: string, payload: unknown) {
      act(() => {
        (handlers[event] || []).forEach((f) => f(payload));
      });
    },
  };
}

let fake: ReturnType<typeof makeFakeSocket>;

// Point the lobby hook at our fake socket instead of the real singleton.
vi.mock('../socket.ts', () => ({
  get socket() {
    return fake.socket;
  },
  createSocket: () => fake.socket,
}));

// The active-game screen mounts the MapLibre map, which needs a WebGL context
// jsdom lacks. Stub it with the shared inert stub.
vi.mock('maplibre-gl', async () => {
  const { default: stub } = await import('../test/maplibreStub.ts');
  return { default: stub };
});

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    roomCode: 'AB2C',
    status: 'lobby',
    players: [{ id: 'p1', name: 'Ada', role: 'hunter', ready: false, isHost: true }],
    createdAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  fake = makeFakeSocket();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Drop any per-test navigator.share stub so it doesn't change another test's
  // share path (jsdom has no native share sheet by default).
  Reflect.deleteProperty(navigator, 'share');
});

describe('<Lobby /> — join screen', () => {
  it('creates a game and shows the room code', async () => {
    const user = userEvent.setup();
    fake.setResponder(() => ({ ok: true, game: game(), playerId: 'p1' }));
    render(<Lobby />);

    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.click(screen.getByRole('button', { name: /create game/i }));

    expect(fake.emitWithAck).toHaveBeenCalledWith('create_game', { name: 'Ada' });
    expect(await screen.findByText('AB2C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start game/i })).toBeInTheDocument();
  });

  it('joins by code and surfaces a bad-code error', async () => {
    const user = userEvent.setup();
    fake.setResponder((event) =>
      event === 'join_game'
        ? { ok: false, error: 'No room with that code', code: 'game_not_found' }
        : { ok: false, error: 'x' },
    );
    render(<Lobby />);

    await user.type(screen.getByLabelText(/your name/i), 'Bo');
    await user.type(screen.getByLabelText(/room code/i), 'zzzz');
    await user.click(screen.getByRole('button', { name: /^join$/i }));

    // Code is upper-cased before it leaves the client.
    expect(fake.emitWithAck).toHaveBeenCalledWith('join_game', { roomCode: 'ZZZZ', name: 'Bo' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/no room with that code/i);
  });

  it('disables the create button until a name is entered', async () => {
    const user = userEvent.setup();
    render(<Lobby />);
    const create = screen.getByRole('button', { name: /create game/i });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    expect(create).toBeEnabled();
  });
});

describe('<Lobby /> — in the room', () => {
  async function enterRoom(initial: Game) {
    const user = userEvent.setup();
    fake.setResponder(() => ({ ok: true, game: initial, playerId: 'p1' }));
    render(<Lobby />);
    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.click(screen.getByRole('button', { name: /create game/i }));
    await screen.findByText(initial.roomCode);
    return user;
  }

  it('toggles ready and switches sides via the socket', async () => {
    const user = await enterRoom(game());

    await user.click(screen.getByRole('button', { name: /i'm ready/i }));
    expect(fake.emitWithAck).toHaveBeenCalledWith('set_ready', { ready: true });

    await user.click(screen.getByRole('button', { name: 'hider' }));
    expect(fake.emitWithAck).toHaveBeenCalledWith('set_role', { role: 'hider' });
  });

  it('keeps the host start button disabled until everyone is ready', async () => {
    const user = await enterRoom(game());
    const start = screen.getByRole('button', { name: /start game/i });
    expect(start).toBeDisabled(); // only one player, not ready

    // A second player joins and both ready up via a broadcast.
    fake.push('lobby_update', {
      game: game({
        players: [
          { id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true },
          { id: 'p2', name: 'Bo', role: 'hider', ready: true, isHost: false },
        ],
      }),
    });

    await waitFor(() => expect(start).toBeEnabled());

    await user.click(start);
    expect(fake.emitWithAck).toHaveBeenCalledWith('start_game', {});
  });

  it('groups players into hunters and hiders lists from lobby_update broadcasts', async () => {
    await enterRoom(game());
    fake.push('lobby_update', {
      game: game({
        players: [
          { id: 'p1', name: 'Ada', role: 'hunter', ready: false, isHost: true },
          { id: 'p2', name: 'Bo', role: 'hider', ready: true, isHost: false },
        ],
      }),
    });

    const hunters = await screen.findByRole('list', { name: /hunters/i });
    const hiders = screen.getByRole('list', { name: /hiders/i });
    expect(within(hunters).getByText(/ada/i)).toBeInTheDocument();
    expect(within(hunters).queryByText('Bo')).not.toBeInTheDocument();
    expect(within(hiders).getByText('Bo')).toBeInTheDocument();
    expect(within(hiders).queryByText(/ada/i)).not.toBeInTheDocument();

    // Bo has readied up; Ada has not — the per-row ready mark reflects each.
    expect(within(hunters).getByLabelText(/ada is not ready/i)).toBeInTheDocument();
    expect(within(hiders).getByLabelText(/bo is ready/i)).toBeInTheDocument();
  });

  it('copies the room code to the clipboard from the share control', async () => {
    const user = await enterRoom(game());
    // Install the stub after enterRoom: userEvent.setup() replaces
    // navigator.clipboard with its own, so override it once setup has run.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: /share/i }));
    expect(writeText).toHaveBeenCalledWith('AB2C');
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('uses the native share sheet on devices that support it', async () => {
    const user = await enterRoom(game());
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: /share/i }));
    // The native sheet is used with the room code in the invite; no clipboard fallback.
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('AB2C') }),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('shows a waiting message to non-hosts and the game-on screen when active', async () => {
    // Enter as a non-host guest.
    const guest = game({
      players: [
        { id: 'p0', name: 'Host', role: 'hunter', ready: true, isHost: true },
        { id: 'p1', name: 'Ada', role: 'hider', ready: true, isHost: false },
      ],
    });
    await enterRoom(guest);
    expect(screen.getByText(/waiting for the host/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start game/i })).not.toBeInTheDocument();

    fake.push('lobby_update', { game: { ...guest, status: 'active' } });
    expect(await screen.findByText(/game on/i)).toBeInTheDocument();
  });
});
