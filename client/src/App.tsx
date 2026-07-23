import { useEffect } from 'react';
import { socket } from './socket.ts';
import { useConnection, type ConnectionStatus } from './useConnection.ts';
import Lobby from './lobby/Lobby.tsx';
import './App.css';

/** The status dot's tone and label for each connection state. */
function statusLabel(status: ConnectionStatus): { tone: 'on' | 'off' | 'offline'; text: string } {
  switch (status) {
    case 'connected':
      return { tone: 'on', text: 'Connected to server' };
    case 'reconnecting':
      return { tone: 'off', text: 'Reconnecting…' };
    default:
      return { tone: 'offline', text: 'Offline' };
  }
}

/**
 * Landing shell for the Manhunt PWA. It wires up the Socket.IO connection,
 * surfaces its live status — connected, auto-reconnecting after a signal loss,
 * or offline (BACKLOG.md #24) — and hosts the {@link Lobby} (create/join a room,
 * pick a side, ready up, start).
 */
export default function App() {
  const status = useConnection(socket);

  useEffect(() => {
    // The socket auto-reconnects on its own (see socket.ts); we just open it on
    // mount and close it on unmount.
    socket.connect();
    return () => {
      socket.disconnect();
    };
  }, []);

  const { tone, text } = statusLabel(status);

  return (
    <main className="app">
      <Lobby />

      <p className="status" role="status">
        <span className={`status__dot status__dot--${tone}`} data-testid="status-dot" />
        {text}
      </p>
    </main>
  );
}
