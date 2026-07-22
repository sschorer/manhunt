import { useEffect, useState } from 'react';
import { socket } from './socket.ts';
import Lobby from './lobby/Lobby.tsx';
import './App.css';

/**
 * Landing shell for the Manhunt PWA. It wires up the Socket.IO connection,
 * surfaces its live status, and hosts the {@link Lobby} (create/join a room,
 * pick a side, ready up, start). The in-game map screen is tracked in the
 * backlog.
 */
export default function App() {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.disconnect();
    };
  }, []);

  return (
    <main className="app">
      <Lobby />

      <p className="status" role="status">
        <span
          className={`status__dot ${connected ? 'status__dot--on' : 'status__dot--off'}`}
          data-testid="status-dot"
        />
        {connected ? 'Connected to server' : 'Connecting…'}
      </p>
    </main>
  );
}
