import Lobby from './lobby/Lobby.tsx';
import './App.css';

/**
 * Landing shell for the Manhunt PWA. It hosts the {@link Lobby} (create or join
 * a Game, pick a side, ready up, start), which opens the Game's own socket and
 * hands the live screens their connection — so the shell itself has nothing to
 * wire up.
 */
export default function App() {
  return (
    <main className="app">
      <Lobby />
    </main>
  );
}
