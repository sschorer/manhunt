import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import App from './App.tsx';

// Fake Socket.IO client so the unit test never opens a real connection.
const { fakeSocket, handlers } = vi.hoisted(() => {
  const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
  const fakeSocket = {
    connected: false,
    on(event: string, cb: (arg?: unknown) => void) {
      (handlers[event] ||= []).push(cb);
    },
    off(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== cb);
    },
    emitLocal(event: string, arg?: unknown) {
      (handlers[event] || []).forEach((f) => f(arg));
    },
    connect: vi.fn(() => {
      fakeSocket.connected = true;
      fakeSocket.emitLocal('connect');
    }),
    disconnect: vi.fn((reason?: unknown) => {
      fakeSocket.connected = false;
      fakeSocket.emitLocal('disconnect', reason);
    }),
  };
  return { fakeSocket, handlers };
});

vi.mock('./socket.ts', () => ({
  socket: fakeSocket,
  createSocket: () => fakeSocket,
}));

beforeEach(() => {
  cleanup();
  fakeSocket.connected = false;
  fakeSocket.connect.mockClear();
  fakeSocket.disconnect.mockClear();
  for (const key of Object.keys(handlers)) delete handlers[key];
});

describe('<App />', () => {
  it('renders the Manhunt landing screen with the lobby entry', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'MANHUNT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create game/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/room code/i)).toBeInTheDocument();
  });

  it('connects on mount and reflects the connected status', () => {
    render(<App />);
    expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Connected to server');
    expect(screen.getByTestId('status-dot')).toHaveClass('status__dot--on');
  });

  it('reflects a recoverable drop as reconnecting', () => {
    render(<App />);
    act(() => {
      // A transport drop (no terminal reason) — the socket auto-reconnects.
      fakeSocket.disconnect('transport close');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
    expect(screen.getByTestId('status-dot')).toHaveClass('status__dot--off');
  });

  it('reflects a server-forced close as offline', () => {
    render(<App />);
    act(() => {
      fakeSocket.disconnect('io server disconnect');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Offline');
    expect(screen.getByTestId('status-dot')).toHaveClass('status__dot--offline');
  });

  it('disconnects on unmount', () => {
    const { unmount } = render(<App />);
    fakeSocket.disconnect.mockClear();
    unmount();
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });
});
