import { useEffect, useState } from 'react';
import { socket } from './socket.ts';
import './App.css';

/**
 * Landing shell for the Manhunt PWA. This is the scaffold entry point — the
 * real lobby / map / game-over screens are tracked in the backlog. It wires up
 * the Socket.IO connection and surfaces its live status so the plumbing is
 * verifiable end to end.
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
      <div className="logo" aria-hidden="true">
        <span className="logo__ring logo__ring--teal" />
        <span className="logo__ring logo__ring--red" />
        <span className="logo__diamond" />
      </div>

      <h1 className="title">MANHUNT</h1>
      <p className="tagline">Real-world GPS hide&nbsp;&amp;&nbsp;seek</p>

      <button className="cta" type="button" disabled>
        Create or join a game
      </button>
      <p className="hint">Lobby coming soon — see the backlog.</p>

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
