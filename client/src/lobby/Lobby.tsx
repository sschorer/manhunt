import { useState, type FormEvent } from 'react';
import { useLobby } from './useLobby.ts';
import CodeInput, { CODE_LENGTH } from './CodeInput.tsx';
import ActiveGame from '../game/ActiveGame.tsx';
import GameOver from '../game/GameOver.tsx';
import { useGameOver } from '../game/useGameOver.ts';
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
  const codeComplete = code.length === CODE_LENGTH;

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (trimmedName) onCreate(trimmedName);
  };

  const handleJoin = (e: FormEvent) => {
    e.preventDefault();
    if (trimmedName && codeComplete) onJoin(code, trimmedName);
  };

  return (
    <>
      <div className="logo" aria-hidden="true">
        <span className="logo__ring logo__ring--teal" />
        <span className="logo__ring logo__ring--red" />
        <span className="logo__diamond" />
      </div>

      <h1 className="title">MANHUNT</h1>
      <p className="tagline">Real-world GPS hide&nbsp;&amp;&nbsp;seek</p>

      <form className="lobby-card lobby-card--join" onSubmit={handleJoin}>
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

        <button
          className="btn btn--primary btn--create"
          type="button"
          onClick={handleCreate}
          disabled={pending || !trimmedName}
        >
          Create game
        </button>

        <div className="lobby-divider">
          <span>or join a room</span>
        </div>

        <CodeInput value={code} onChange={setCode} disabled={pending} />

        {error ? (
          <p className="lobby-error" role="alert">
            {error}
          </p>
        ) : null}

        <button
          className="btn btn--ghost"
          type="submit"
          disabled={pending || !trimmedName || !codeComplete}
        >
          Join
        </button>

        <p className="lobby-footnote">No account needed to play</p>
      </form>
    </>
  );
}

/** First letter of a name, for the row avatar. */
function avatarInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/** A single roster row: avatar, name (+ host/you tags), and ready mark. */
function PlayerRow({ player, playerId }: { player: Player; playerId: string | null }) {
  const { role, name, ready, isHost } = player;
  return (
    <li className={`roster__row roster__row--${role}`}>
      <span className={`avatar avatar--${role}`} aria-hidden="true">
        {avatarInitial(name)}
      </span>
      <span className="roster__meta">
        <span className="roster__name">
          {name}
          {player.id === playerId ? <span className="roster__you"> (you)</span> : null}
          {isHost ? <span className="roster__host"> · host</span> : null}
        </span>
        <span className={`role-label role-label--${role}`}>{role}</span>
      </span>
      <span
        className={`ready-mark ${ready ? 'ready-mark--on' : 'ready-mark--off'}`}
        role="img"
        aria-label={ready ? `${name} is ready` : `${name} is not ready`}
      >
        {ready ? '✓' : ''}
      </span>
    </li>
  );
}

/** One side's roster — a labelled list with a live count. */
function TeamList({
  role,
  players,
  playerId,
}: {
  role: Role;
  players: Player[];
  playerId: string | null;
}) {
  const title = role === 'hunter' ? 'Hunters' : 'Hiders';
  return (
    <section className="team">
      <h2 className="team__heading">
        <span className={`team__title team__title--${role}`}>{title}</span>
        <span className="team__count">{players.length}</span>
      </h2>
      <ul className="roster" aria-label={title}>
        {players.length === 0 ? (
          <li className="roster__empty">No {role}s yet</li>
        ) : (
          players.map((p) => <PlayerRow key={p.id} player={p} playerId={playerId} />)
        )}
      </ul>
    </section>
  );
}

/** The room-code chip. Shares via the device's native share sheet where one
 *  exists (mobile), and falls back to copying the code to the clipboard. */
function RoomCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const share = async (): Promise<void> => {
    const data = {
      title: 'Manhunt',
      text: `Join my Manhunt game — room code ${code}`,
      url: window.location.origin,
    };

    // Prefer the platform share sheet (mobile) so people can send the invite
    // through whatever messaging app they use.
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
      } catch {
        // The user dismissed the share sheet, or it failed — nothing to do.
      }
      return;
    }

    // No native share (typically desktop): copy the code to the clipboard.
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable or denied — the code chip is still visible to read out.
    }
  };

  return (
    <div className="room-code">
      <span className="room-code__label">Room</span>
      <span className="room-code__value">{code}</span>
      <button type="button" className="room-code__share" onClick={share}>
        {copied ? 'Copied ✓' : 'Share'}
      </button>
    </div>
  );
}

/** A one-line summary of the roster's readiness. */
function readySummary(game: Game): string {
  const total = game.players.length;
  const notReady = game.players.filter((p) => !p.ready).length;
  const players = `${total} ${total === 1 ? 'player' : 'players'}`;
  return notReady === 0 ? `${players} · all ready` : `${players} · ${notReady} not ready`;
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
  const hunters = game.players.filter((p) => p.role === 'hunter');
  const hiders = game.players.filter((p) => p.role === 'hider');

  return (
    <div className="lobby-card lobby-card--room">
      <div className="room-head">
        <RoomCode code={game.roomCode} />
        <p className="room-summary">{readySummary(game)}</p>
      </div>

      <div className="teams">
        <TeamList role="hunter" players={hunters} playerId={playerId} />
        <TeamList role="hider" players={hiders} playerId={playerId} />
      </div>

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
 * The lobby feature and the screen router for a session: create or join a room,
 * pick a side, ready up, and let the host start. Once the game goes `active` the
 * {@link ActiveGame} screen takes over; when the server ends the match it
 * broadcasts a summary and the {@link GameOver} end screen takes over from there
 * (BACKLOG.md #19), whose "play again" drops back to the join screen.
 */
export default function Lobby() {
  const lobby = useLobby();
  const { game, playerId, error, pending } = lobby;

  // Latch the server's end-of-game summary for the current room. When it lands
  // (last hider caught, or the timer ran out) the game-over screen takes over —
  // regardless of the roster's terminal status, since the `game_over` broadcast
  // is what carries the summary the end screen renders.
  const summary = useGameOver(game?.id ?? null);

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

  if (summary && summary.gameId === game.id) {
    return <GameOver summary={summary} onPlayAgain={lobby.leave} />;
  }

  if (game.status === 'active') {
    return <ActiveGame game={game} playerId={playerId} onLeave={lobby.leave} />;
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
