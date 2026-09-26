import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActiveGame from './ActiveGame.tsx';
import type { Game } from '@manhunt/shared';
import type { GameConnection } from '../transport/gameConnection.ts';

// Fake the shared socket so no real connection opens and we can assert emits and
// drive connection lifecycle events (connect/disconnect) by hand.
const { fakeSocket, handlers } = vi.hoisted(() => {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const fakeSocket = {
    connected: true,
    emit: vi.fn(),
    on(event: string, cb: (arg?: unknown) => void) {
      (handlers[event] ||= []).push(cb);
    },
    off(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== cb);
    },
    emitLocal(event: string, arg?: unknown) {
      (handlers[event] || []).forEach((f) => f(arg));
    },
  };
  return { fakeSocket, handlers };
});
vi.mock('../socket.ts', () => ({
  socket: fakeSocket,
  createSocket: () => fakeSocket,
}));

// MapLibre needs a real WebGL context, which jsdom has no notion of. Stub it
// with the shared inert stub so ActiveGame can mount the map in tests.
vi.mock('maplibre-gl', async () => {
  const { default: stub } = await import('../test/maplibreStub.ts');
  return { default: stub };
});

// Drive navigator.geolocation.watchPosition by hand.
let success: PositionCallback | null = null;
const watchPosition = vi.fn((ok: PositionCallback) => {
  success = ok;
  return 1;
});
const clearWatch = vi.fn();

function emitFix(lat: number, lng: number) {
  act(() => {
    success?.({
      coords: {
        latitude: lat,
        longitude: lng,
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as GeolocationPosition);
  });
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    roomCode: 'AB2C',
    status: 'active',
    players: [
      { id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true },
      { id: 'p2', name: 'Rui', role: 'hider', ready: true, isHost: false },
    ],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A fake Game connection whose listeners a test can fire, as the Worker backend would. */
function fakeConnection() {
  const listeners = new Map<string, (payload: unknown) => void>();
  let openListener: ((open: boolean) => void) | undefined;
  const connection = {
    send: vi.fn(),
    request: vi.fn(),
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
    onClose: vi.fn(() => () => {}),
    onOpenChange: vi.fn((listener: (open: boolean) => void) => {
      openListener = listener;
      return () => {
        openListener = undefined;
      };
    }),
    isOpen: () => true,
  } as unknown as GameConnection & {
    send: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  };
  return {
    connection,
    emit(name: string, payload: unknown) {
      act(() => listeners.get(name)?.(payload));
    },
    /** The socket dropping (`false`) or coming back (`true`), as partysocket reports it. */
    setOpen(open: boolean) {
      act(() => openListener?.(open));
    },
  };
}

beforeEach(() => {
  fakeSocket.emit.mockClear();
  fakeSocket.connected = true;
  for (const key of Object.keys(handlers)) delete handlers[key];
  success = null;
  watchPosition.mockClear();
  clearWatch.mockClear();
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'geolocation');
});

describe('<ActiveGame />', () => {
  it('starts GPS capture and streams position_update ticks', () => {
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} />);

    expect(screen.getByTestId('game-map')).toBeInTheDocument();
    expect(watchPosition).toHaveBeenCalledTimes(1);

    emitFix(52.1, 4.3);

    expect(fakeSocket.emit).toHaveBeenCalledWith('position_update', {
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.1,
      lng: 4.3,
    });
    expect(screen.getByText(/sharing your location/i)).toBeInTheDocument();
    expect(screen.getByTestId('tracking-dot')).toHaveClass('tracking__dot--on');
  });

  it('shows the hunter HUD and the scan-to-catch action for a hunter', () => {
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} />);
    expect(screen.getByTestId('hunter-hud')).toBeInTheDocument();
    expect(screen.getByText('TIME LEFT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan to catch/i })).toBeInTheDocument();
    // No hider sighting yet, so the catch action has no target.
    expect(screen.getByRole('button', { name: /scan to catch/i })).toBeDisabled();
  });

  it('shows the hider HUD and reveal countdown, and no scan action, for a hider', () => {
    render(<ActiveGame game={game()} playerId="p2" onLeave={() => {}} />);
    expect(screen.getByTestId('hider-hud')).toBeInTheDocument();
    expect(screen.getByText(/revealed to hunters in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scan to catch/i })).not.toBeInTheDocument();
  });

  it('stops the watch when it leaves the match', () => {
    const { unmount } = render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} />);
    unmount();
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  it('invokes onLeave from the leave button', async () => {
    const onLeave = vi.fn();
    render(<ActiveGame game={game()} playerId="p1" onLeave={onLeave} />);
    await userEvent.click(screen.getByRole('button', { name: /leave/i }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('shows a last-known-position banner and dims the map on signal loss', () => {
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} />);
    // Connected: no banner, live map.
    expect(screen.queryByText(/last-known positions/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('game-map')).not.toHaveClass('game-map--stale');

    // A recoverable drop — the map freezes on the last-known fixes while the
    // socket auto-reconnects.
    act(() => {
      fakeSocket.connected = false;
      fakeSocket.emitLocal('disconnect', 'transport close');
    });
    expect(screen.getByText(/signal lost — showing last-known positions/i)).toBeInTheDocument();
    expect(screen.getByTestId('game-map')).toHaveClass('game-map--stale');

    // Reconnected: the banner clears and the map goes live again.
    act(() => {
      fakeSocket.connected = true;
      fakeSocket.emitLocal('connect');
    });
    expect(screen.queryByText(/last-known positions/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('game-map')).not.toHaveClass('game-map--stale');
  });

  it('plays over the Game connection when there is one', () => {
    const connection = {
      send: vi.fn(),
      on: vi.fn(() => () => {}),
      onClose: vi.fn(() => () => {}),
      onOpenChange: vi.fn(() => () => {}),
      isOpen: () => true,
    } as unknown as GameConnection & { send: ReturnType<typeof vi.fn> };
    fakeSocket.connected = false;
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} connection={connection} />);

    emitFix(52.1, 4.3);

    expect(connection.send).toHaveBeenCalledWith('position_update', {
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.1,
      lng: 4.3,
    });
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('position_update', expect.anything());
    expect(screen.queryByText(/last-known positions/i)).not.toBeInTheDocument();
  });

  it("counts down with the Game's own game length and ping interval", () => {
    // Starting a minute from now keeps the clock at the full durations.
    const startedAt = new Date(Date.now() + 60_000).toISOString();
    render(
      <ActiveGame
        game={game({ startedAt, rules: { gameDurationMs: 600_000, pingIntervalMs: 60_000 } })}
        playerId="p1"
        onLeave={() => {}}
      />,
    );

    expect(screen.getByText('10:00')).toBeInTheDocument();
    expect(screen.getByText('01:00')).toBeInTheDocument();
  });

  it('shows the offline copy on a terminal disconnect and keeps the map stale', () => {
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} />);

    // A server-forced close won't auto-reconnect — the map stays stale behind the
    // offline copy.
    act(() => {
      fakeSocket.connected = false;
      fakeSocket.emitLocal('disconnect', 'io server disconnect');
    });
    expect(screen.getByText(/offline — showing last-known positions/i)).toBeInTheDocument();
    expect(screen.getByTestId('game-map')).toHaveClass('game-map--stale');
  });

  it('warns the player when the Game says they left the play area', () => {
    const fake = fakeConnection();
    render(<ActiveGame game={game()} playerId="p2" onLeave={() => {}} connection={fake.connection} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fake.emit('boundary_warning', {
      gameId: 'g1',
      playerId: 'p2',
      warnings: 1,
      warningsRemaining: 0,
      metersOutside: 123.4,
      at: new Date().toISOString(),
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/123\s?m outside the boundary/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/head back now/i);
  });

  it('tells an eliminated player they are out and stops sharing their location', () => {
    const eliminated = game({
      players: [
        { id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true },
        { id: 'p2', name: 'Rui', role: 'hider', ready: true, isHost: false, eliminated: true },
      ],
    });

    render(<ActiveGame game={eliminated} playerId="p2" onLeave={() => {}} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/you're out/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/outside the boundary/i);
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('leaves everyone else playing when one player is eliminated', () => {
    const eliminated = game({
      players: [
        { id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true },
        { id: 'p2', name: 'Rui', role: 'hider', ready: true, isHost: false, eliminated: true },
      ],
    });

    render(<ActiveGame game={eliminated} playerId="p1" onLeave={() => {}} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(watchPosition).toHaveBeenCalledTimes(1);
    // The eliminated Hider no longer counts towards the Hiders still out there.
    expect(screen.getByText('HIDERS').closest('.stat')).toHaveTextContent('0 / 1');
  });

  it('tells the rest of the Game who was just eliminated', () => {
    const fake = fakeConnection();
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} connection={fake.connection} />);

    fake.emit('player_eliminated', {
      gameId: 'g1',
      playerId: 'p2',
      reason: 'boundary',
      at: new Date().toISOString(),
    });

    expect(screen.getByText(/Rui is out — they stayed outside the boundary/i)).toBeInTheDocument();
  });

  /**
   * A Hunter with a sighting of the Hider Rui: the Game only discloses a Hider's
   * position on a Ping reveal, and that sighting is what the scan action aims at.
   */
  function hunterWithASighting() {
    const fake = fakeConnection();
    render(<ActiveGame game={game()} playerId="p1" onLeave={() => {}} connection={fake.connection} />);
    emitFix(52.1, 4.3);
    fake.emit('game_state', {
      gameId: 'g1',
      positions: { p2: { lat: 52.1001, lng: 4.3, recordedAt: new Date().toISOString() } },
      reveal: true,
    });
    return fake;
  }

  it('holds the last-known positions while the Game connection is down and takes the snapshot when it is back', () => {
    const fake = hunterWithASighting();
    const sighting = screen.getByText(/hider within/i).textContent;

    fake.setOpen(false);

    expect(screen.getByText(/signal lost — showing last-known positions/i)).toBeInTheDocument();
    expect(screen.getByTestId('game-map')).toHaveClass('game-map--stale');
    expect(screen.getByText(/hider within/i)).toHaveTextContent(String(sighting));

    // Back on a new socket: the Game's snapshot is what the map shows from here,
    // and it has the Hider far away from where the Hunter last saw them.
    fake.setOpen(true);
    fake.emit('game_state', {
      gameId: 'g1',
      positions: { p2: { lat: 52.11, lng: 4.3, recordedAt: new Date().toISOString() } },
      reveal: true,
    });

    expect(screen.queryByText(/last-known positions/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('game-map')).not.toHaveClass('game-map--stale');
    expect(screen.getByText(/no hider nearby/i)).toBeInTheDocument();
  });

  it('claims a Catch on the nearest Hider over the Game connection', async () => {
    const fake = hunterWithASighting();
    fake.connection.request.mockResolvedValue({
      ok: true,
      catch: { gameId: 'g1', hunterId: 'p1', targetId: 'p2', at: new Date().toISOString() },
    });

    await userEvent.click(screen.getByRole('button', { name: /scan to catch/i }));

    expect(fake.connection.request).toHaveBeenCalledWith('claim_catch', {
      gameId: 'g1',
      hunterId: 'p1',
      targetId: 'p2',
    });
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('claim_catch', expect.anything());
    expect(await screen.findByText('Caught!')).toBeInTheDocument();
  });

  it("surfaces the Game's reason for refusing a Catch", async () => {
    const fake = hunterWithASighting();
    fake.connection.request.mockResolvedValue({
      ok: false,
      error: 'You have to be within 15 m of the Hider',
      code: 'out_of_range',
    });

    await userEvent.click(screen.getByRole('button', { name: /scan to catch/i }));

    expect(await screen.findByText(/within 15 m of the hider/i)).toBeInTheDocument();
  });

  it('says so when the claim never reaches the Game', async () => {
    const fake = hunterWithASighting();
    fake.connection.request.mockRejectedValue(new Error('disconnected'));

    await userEvent.click(screen.getByRole('button', { name: /scan to catch/i }));

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    // The button is usable again, so the Hunter can try once more.
    expect(screen.getByRole('button', { name: /scan to catch/i })).toBeEnabled();
  });
});
