import { useState, type FormEvent } from 'react';
import { useLobby } from './useLobby.ts';
import type { Game, Player, Role } from './types.ts';
import './Lobby.css';

const MIN_PLAYERS_TO_START = 2;

/** Mirror of the server's `canStart`: enough players, all readied up. */
function canStart(game: Game): boolean {
  return (
    game.status === 'lobby' &&
    game.players.length >= MIN_PLAYERS_TO_START &&
    game.players.every((p) => p.ready)
  );
}

/** The create-or-join entry screen. */
function JoinScreen({
  onCreate,
  onJoin,
  pending,
  error,
}: {
  onCreate: (name: string) => void;
  onJoin: (roomCode: string, name: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const trimmedName = name.trim();

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (trimmedName) onCreate(trimmedName);
  };

  const handleJoin = (e: FormEvent) => {
    e.preventDefault();
    if (trimmedName && code.trim()) onJoin(code.trim(), trimmedName);
  };

  return (
    <form className="lobby-card" onSubmit={handleJoin}>
      <label className="field">
        <span className="field__label">Your name</span>
        <input
          className="field__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ada"
          maxLength={24}
          autoComplete="off"
          aria-label="Your name"
        />
      </label>

      <label className="field">
        <span className="field__label">Room code</span>
        <input
          className="field__input field__input--code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCD"
          maxLength={5}
          autoComplete="off"
          autoCapitalize="characters"
          aria-label="Room code"
        />
      </label>

      {error ? (
        <p className="lobby-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="lobby-actions">
        <button
          className="btn btn--primary"
          type="submit"
          disabled={pending || !trimmedName || !code.trim()}
        >
          Join game
        </button>
        <button
          className="btn btn--ghost"
          type="button"
          onClick={handleCreate}
          disabled={pending || !trimmedName}
        >
          Create new game
        </button>
      </div>
    </form>
  );
}

/** A single row in the lobby roster. */
function Roster({ players, playerId }: { players: Player[]; playerId: string | null }) {
  return (
    <ul className="roster" aria-label="Players">
      {players.map((p) => (
        <li key={p.id} className="roster__row">
          <span className={`role-chip role-chip--${p.role}`}>{p.role}</span>
          <span className="roster__name">
            {p.name}
            {p.id === playerId ? <span className="roster__you"> (you)</span> : null}
            {p.isHost ? <span className="roster__host" title="Host"> ★</span> : null}
          </span>
          <span
            className={`ready-dot ${p.ready ? 'ready-dot--on' : 'ready-dot--off'}`}
            aria-label={p.ready ? 'ready' : 'not ready'}
          />
        </li>
      ))}
    </ul>
  );
}

/** The in-lobby screen: roster, side picker, ready toggle, host start. */
function LobbyRoom({
  game,
  playerId,
  error,
  onSetRole,
  onSetReady,
  onStart,
  onLeave,
}: {
  game: Game;
  playerId: string | null;
  error: string | null;
  onSetRole: (role: Role) => void;
  onSetReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
}) {
  const me = game.players.find((p) => p.id === playerId);
  const startable = canStart(game);

  return (
    <div className="lobby-card">
      <div className="room-code">
        <span className="room-code__label">Room code</span>
        <span className="room-code__value">{game.roomCode}</span>
      </div>

      <Roster players={game.players} playerId={playerId} />

      {me ? (
        <div className="my-controls">
          <div className="side-toggle" role="group" aria-label="Your side">
            {(['hunter', 'hider'] as const).map((role) => (
              <button
                key={role}
                type="button"
                className={`side-toggle__btn ${me.role === role ? 'side-toggle__btn--active' : ''}`}
                aria-pressed={me.role === role}
                onClick={() => onSetRole(role)}
              >
                {role}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`btn ${me.ready ? 'btn--ghost' : 'btn--primary'}`}
            onClick={() => onSetReady(!me.ready)}
          >
            {me.ready ? "I'm not ready" : "I'm ready"}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="lobby-error" role="alert">
          {error}
        </p>
      ) : null}

      {me?.isHost ? (
        <button
          type="button"
          className="btn btn--start"
          onClick={onStart}
          disabled={!startable}
        >
          Start game
        </button>
      ) : (
        <p className="hint">Waiting for the host to start…</p>
      )}

      {me?.isHost && !startable ? (
        <p className="hint">Everyone must ready up (at least {MIN_PLAYERS_TO_START} players).</p>
      ) : null}

      <button type="button" className="lobby-leave" onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}

/**
 * The lobby feature: create or join a room, pick a side, ready up, and let the
 * host start. Once the game goes `active` the map screen takes over (tracked in
 * the backlog); for now that's a placeholder.
 */
export default function Lobby() {
  const lobby = useLobby();
  const { game, playerId, error, pending } = lobby;

  if (!game) {
    return (
      <JoinScreen
        onCreate={lobby.createGame}
        onJoin={lobby.joinGame}
        pending={pending}
        error={error}
      />
    );
  }

  if (game.status === 'active') {
    return (
      <div className="lobby-card lobby-card--active">
        <h2 className="active-title">Game on!</h2>
        <p className="hint">
          The match has started. The live map is coming next — see the backlog.
        </p>
        <button type="button" className="lobby-leave" onClick={lobby.leave}>
          Leave
        </button>
      </div>
    );
  }

  return (
    <LobbyRoom
      game={game}
      playerId={playerId}
      error={error}
      onSetRole={lobby.setRole}
      onSetReady={lobby.setReady}
      onStart={lobby.startGame}
      onLeave={lobby.leave}
    />
  );
}
