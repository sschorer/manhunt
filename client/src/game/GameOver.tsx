import { useState, type ReactNode } from 'react';
import { formatClock } from './matchClock.ts';
import {
  outcomeLine,
  survivorCount,
  topSurvivalMs,
  winTitle,
  type GameSummary,
  type HiderOutcome,
} from './summary.ts';
import './GameOver.css';

/**
 * The post-game / end screen shown once the server ends a match (BACKLOG.md #19,
 * mockup screen 07). It renders the win banner ("HIDERS WIN" / "HUNTERS WIN"),
 * the headline stats (catches, survivors, longest survival), a per-hider survival
 * board, and the two closing actions — share the result and play again.
 *
 * Every value comes from the authoritative `game_over` summary (see
 * {@link GameSummary}); the screen recomputes nothing. Full movement replay
 * (BACKLOG.md #25) needs the position history the server doesn't stream yet, so
 * the board visualises the one time-series we do have — how long each hider
 * lasted — rather than fabricating a track.
 */
export default function GameOver({
  summary,
  onPlayAgain,
}: {
  summary: GameSummary;
  onPlayAgain: () => void;
}) {
  const side = summary.winner; // 'hiders' | 'hunters'

  return (
    <div className={`gameover gameover--${side}`} data-testid="game-over">
      <header className={`gameover__banner gameover__banner--${side}`}>
        <p className="gameover__eyebrow">MATCH OVER</p>
        <h1 className="gameover__title">{winTitle(summary.winner)}</h1>
        <p className="gameover__subtitle">{outcomeLine(summary)}</p>
      </header>

      <div className="gameover__stats">
        <EndStat label="CATCHES" value={summary.catches.length} tone="alert" />
        <EndStat label="SURVIVORS" value={survivorCount(summary)} tone="teal" />
        <EndStat label="TOP TIME" value={formatClock(topSurvivalMs(summary))} tone="teal" />
      </div>

      <SurvivalBoard hiders={summary.hiders} durationMs={summary.durationMs} />

      <div className="gameover__actions">
        <ShareButton summary={summary} />
        <button
          type="button"
          className="gameover__btn gameover__btn--primary"
          onClick={onPlayAgain}
        >
          Play again
        </button>
      </div>
    </div>
  );
}

/** One centred headline stat — a big value over a small caps label. */
function EndStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone: 'teal' | 'alert' | 'default';
}) {
  return (
    <div className={`endstat endstat--${tone}`}>
      <span className="endstat__value">{value}</span>
      <span className="endstat__label">{label}</span>
    </div>
  );
}

/**
 * The survival board: each original hider as a bar proportional to how long they
 * lasted, longest first (the server already sorts them). A caught hider's bar is
 * red and tagged with the time they went down; a survivor's is teal and tagged
 * "survived".
 */
function SurvivalBoard({
  hiders,
  durationMs,
}: {
  hiders: HiderOutcome[];
  durationMs: number;
}) {
  // Scale bars against the longest survival so the leader fills the track — a
  // more legible reference than the raw duration when the match ended early.
  const longest = hiders.reduce((best, h) => Math.max(best, h.survivalMs), 0);
  const scale = Math.max(longest, durationMs, 1);

  return (
    <section className="board" aria-label="Survival">
      <h2 className="board__heading">SURVIVAL</h2>
      {hiders.length === 0 ? (
        <p className="board__empty">No hiders this match</p>
      ) : (
        <ul className="board__list">
          {hiders.map((h) => (
            <li key={h.playerId} className="board__row">
              <span className="board__name">{h.name}</span>
              <span className="board__track" aria-hidden="true">
                <span
                  className={`board__bar board__bar--${h.caught ? 'caught' : 'survived'}`}
                  style={{ width: `${(h.survivalMs / scale) * 100}%` }}
                />
              </span>
              <span className={`board__time board__time--${h.caught ? 'caught' : 'survived'}`}>
                {formatClock(h.survivalMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Share the match result through the device's native share sheet where one exists
 * (mobile), falling back to copying a short summary to the clipboard — the same
 * pattern the lobby's room-code chip uses. Shares the outcome as text; the full
 * movement replay it would ideally attach is future work (BACKLOG.md #25).
 */
function ShareButton({ summary }: { summary: GameSummary }) {
  const [copied, setCopied] = useState(false);

  const text = `Manhunt — ${winTitle(summary.winner)}. ${outcomeLine(summary)}, ${
    summary.catches.length
  } ${summary.catches.length === 1 ? 'catch' : 'catches'}.`;

  const share = async (): Promise<void> => {
    const data = { title: 'Manhunt', text, url: window.location.origin };

    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
      } catch {
        // The user dismissed the share sheet, or it failed — nothing to do.
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable or denied — nothing more we can do here.
    }
  };

  return (
    <button type="button" className="gameover__btn gameover__btn--ghost" onClick={share}>
      {copied ? 'Copied ✓' : '↗ Share result'}
    </button>
  );
}
