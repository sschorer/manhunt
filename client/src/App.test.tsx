import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.tsx';

// The shell's only job is to host the Lobby, which opens the Game's own socket on
// mount. Stub `connectToGame` so the unit test never opens a real WebSocket.
vi.mock('./transport/gameConnection.ts', () => ({
  connectToGame: () => ({
    on: () => () => {},
    onClose: () => () => {},
    onOpenChange: () => () => {},
    isOpen: () => false,
    request: () => Promise.resolve({ ok: true }),
    send: () => {},
    close: () => {},
  }),
}));

afterEach(() => cleanup());

describe('<App />', () => {
  it('renders the Manhunt landing screen with the lobby entry', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'MANHUNT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create game/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/room code/i)).toBeInTheDocument();
  });
});
