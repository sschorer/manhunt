import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActiveGame from './ActiveGame.tsx';
import type { Game } from '../lobby/types.ts';

// Fake the shared socket so no real connection opens and we can assert emits.
const { fakeSocket } = vi.hoisted(() => ({
  fakeSocket: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('../socket.ts', () => ({
  socket: fakeSocket,
  createSocket: () => fakeSocket,
}));

// MapLibre needs a real WebGL context, which jsdom has no notion of. Stub it
// with inert Map/Marker classes so ActiveGame can mount the map in tests.
vi.mock('maplibre-gl', () => {
  class FakeMap {
    on(event: string, cb: () => void) {
      if (event === 'load') cb();
      return this;
    }
    addSource() {}
    addLayer() {}
    getSource() {
      return { setData: () => {} };
    }
    easeTo() {}
    remove() {}
  }
  class FakeMarker {
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }
  return { default: { Map: FakeMap, Marker: FakeMarker } };
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
    players: [{ id: 'p1', name: 'Ada', role: 'hunter', ready: true, isHost: true }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  fakeSocket.emit.mockClear();
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

    expect(screen.getByRole('heading', { name: /game on/i })).toBeInTheDocument();
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
});
