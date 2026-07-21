import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import App from './App.jsx';

// Fake Socket.IO client so the unit test never opens a real connection.
const { fakeSocket, handlers } = vi.hoisted(() => {
  const handlers = {};
  const fakeSocket = {
    connected: false,
    on(event, cb) {
      (handlers[event] ||= []).push(cb);
    },
    off(event, cb) {
      handlers[event] = (handlers[event] || []).filter((f) => f !== cb);
    },
    emitLocal(event) {
      (handlers[event] || []).forEach((f) => f());
    },
    connect: vi.fn(function connect() {
      this.connected = true;
      this.emitLocal('connect');
    }),
    disconnect: vi.fn(function disconnect() {
      this.connected = false;
      this.emitLocal('disconnect');
    }),
  };
  return { fakeSocket, handlers };
});

vi.mock('./socket.js', () => ({
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
  it('renders the Manhunt landing screen', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'MANHUNT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create or join/i })).toBeDisabled();
  });

  it('connects on mount and reflects the connected status', () => {
    render(<App />);
    expect(fakeSocket.connect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Connected to server');
    expect(screen.getByTestId('status-dot')).toHaveClass('status__dot--on');
  });

  it('reflects a dropped connection', () => {
    render(<App />);
    act(() => {
      fakeSocket.disconnect();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connecting');
    expect(screen.getByTestId('status-dot')).toHaveClass('status__dot--off');
  });

  it('disconnects on unmount', () => {
    const { unmount } = render(<App />);
    fakeSocket.disconnect.mockClear();
    unmount();
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });
});
