import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Lobby from './Lobby.tsx';
import type { Game, OutboundEventMap } from '@manhunt/shared';

/**
 * The Game's own socket, faked: it records the requests the screen sends and lets
 * a test drive an inbound `lobby_update` the way the Game broadcasts one.
 */
function makeFakeConnection() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const request = vi.fn(() => Promise.resolve<unknown>({ ok: true }));
  const connection = {
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    onClose: vi.fn(() => () => {}),
    onOpenChange: vi.fn(() => () => {}),
    isOpen: () => true,
    request,
    send: vi.fn(),
    close: vi.fn(),
  };
  return {
    connection,
    request,
    push<K extends keyof OutboundEventMap>(name: K, payload: OutboundEventMap[K]) {
      act(() => listeners.get(name)?.(payload));
    },
  };
}

let fake: ReturnType<typeof makeFakeConnection>;

// The Lobby opens the Game's socket itself; hand it the fake instead of a real one.
vi.mock('../transport/gameConnection.ts', () => ({
  connectToGame: () => fake.connection,
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

/** Stub `fetch` so create/join answer with `initial`, or with an error body. */
function stubFetch(answer: (path: string) => { status: number; body: unknown }) {
  const doFetch = vi.fn((input: RequestInfo | URL) => {
    const { status, body } = answer(String(input));
    return Promise.resolve(Response.json(body, { status }));
  });
  vi.stubGlobal('fetch', doFetch);
  return doFetch;
}

beforeEach(() => {
  fake = makeFakeConnection();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  // Drop any per-test navigator.share stub so it doesn't change another test's
  // share path (jsdom has no native share sheet by default).
  Reflect.deleteProperty(navigator, 'share');
});

describe('<Lobby /> — join screen', () => {
  it('creates a game and shows the room code', async () => {
    const user = userEvent.setup();
    const doFetch = stubFetch(() => ({ status: 201, body: { game: game(), playerId: 'p1' } }));
    render(<Lobby />);

    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.click(screen.getByRole('button', { name: /create game/i }));

    expect(doFetch).toHaveBeenCalledWith(
      '/api/games',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Ada' }) }),
    );
    expect(await screen.findByText('AB2C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start game/i })).toBeInTheDocument();
  });

  it('joins by code and surfaces a bad-code error', async () => {
    const user = userEvent.setup();
    const doFetch = stubFetch(() => ({
      status: 404,
      body: { ok: false, error: 'No Game with that code', code: 'game_not_found' },
    }));
    render(<Lobby />);

    await user.type(screen.getByLabelText(/your name/i), 'Bo');
    await user.type(screen.getByLabelText(/room code/i), 'zzzz');
    await user.click(screen.getByRole('button', { name: /^join$/i }));

    // Code is upper-cased before it leaves the client.
    expect(doFetch).toHaveBeenCalledWith(
      '/api/games/join',
      expect.objectContaining({ body: JSON.stringify({ code: 'ZZZZ', name: 'Bo' }) }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/no game with that code/i);
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
    stubFetch(() => ({ status: 201, body: { game: initial, playerId: 'p1' } }));
    render(<Lobby />);
    await user.type(screen.getByLabelText(/your name/i), 'Ada');
    await user.click(screen.getByRole('button', { name: /create game/i }));
    await screen.findByText(initial.roomCode);
    return user;
  }

  it("toggles ready and switches sides over the Game's socket", async () => {
    const user = await enterRoom(game());

    await user.click(screen.getByRole('button', { name: /i'm ready/i }));
    expect(fake.request).toHaveBeenCalledWith('set_ready', { ready: true });

    await user.click(screen.getByRole('button', { name: 'hider' }));
    expect(fake.request).toHaveBeenCalledWith('set_role', { role: 'hider' });
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
    expect(fake.request).toHaveBeenCalledWith('start_game', {});
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

  it('shows a waiting message to non-hosts and the match screen when active', async () => {
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
    // The guest is a hider, so the hider HUD (with its reveal countdown) takes over.
    expect(await screen.findByTestId('hider-hud')).toBeInTheDocument();
  });

  it('shows the end screen when the Game broadcasts its summary', async () => {
    await enterRoom(game());

    fake.push('game_over', {
      gameId: 'g1',
      summary: {
        gameId: 'g1',
        winner: 'hunters',
        reason: 'all_caught',
        startedAt: '2026-07-21T00:00:00.000Z',
        endedAt: '2026-07-21T00:10:00.000Z',
        durationMs: 600_000,
        catches: [],
        hiders: [],
      },
    });

    expect(await screen.findByRole('heading', { name: /hunters win/i })).toBeInTheDocument();
  });
});
