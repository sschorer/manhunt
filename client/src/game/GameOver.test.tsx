import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GameOver from './GameOver.tsx';
import type { GameSummary } from './summary.ts';

function summary(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    gameId: 'g1',
    winner: 'hiders',
    reason: 'timer',
    startedAt: '2026-07-22T10:00:00.000Z',
    endedAt: '2026-07-22T10:25:00.000Z',
    durationMs: 1_500_000, // 25:00
    catches: [
      { hunterId: 'h1', targetId: 'c', at: '2026-07-22T10:11:40.000Z' },
    ],
    hiders: [
      { playerId: 'a', name: 'Ana', caught: false, survivalMs: 1_500_000 },
      { playerId: 'b', name: 'Rui', caught: false, survivalMs: 1_500_000 },
      { playerId: 'c', name: 'Leo', caught: true, survivalMs: 700_000, caughtAt: '2026-07-22T10:11:40.000Z' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  // Reset the navigator patches the share/clipboard tests install.
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'clipboard');
});

afterEach(() => {
  cleanup();
});

describe('GameOver', () => {
  it('shows the hiders-win banner and outcome line', () => {
    render(<GameOver summary={summary()} onPlayAgain={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'HIDERS WIN' })).toBeInTheDocument();
    expect(screen.getByText('2 survived the full 25:00')).toBeInTheDocument();
  });

  it('shows the hunters-win banner when everyone was caught', () => {
    render(
      <GameOver
        summary={summary({
          winner: 'hunters',
          reason: 'all_caught',
          durationMs: 754_000,
          hiders: [
            { playerId: 'a', name: 'Ana', caught: true, survivalMs: 754_000 },
          ],
        })}
        onPlayAgain={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'HUNTERS WIN' })).toBeInTheDocument();
    expect(screen.getByText('All hiders caught in 12:34')).toBeInTheDocument();
  });

  it('renders the headline stats: catches, survivors, top time', () => {
    render(<GameOver summary={summary()} onPlayAgain={vi.fn()} />);
    const stats = screen.getByText('CATCHES').closest('.gameover__stats');
    expect(stats).not.toBeNull();
    const s = within(stats as HTMLElement);
    // CATCHES = 1
    expect(s.getByText('CATCHES').previousSibling).toHaveTextContent('1');
    // SURVIVORS = 2
    expect(s.getByText('SURVIVORS').previousSibling).toHaveTextContent('2');
    // TOP TIME = 25:00 (longest survival)
    expect(s.getByText('TOP TIME').previousSibling).toHaveTextContent('25:00');
  });

  it('lists every hider on the survival board with their time', () => {
    render(<GameOver summary={summary()} onPlayAgain={vi.fn()} />);
    const board = screen.getByRole('region', { name: 'Survival' });
    const b = within(board);
    expect(b.getByText('Ana')).toBeInTheDocument();
    expect(b.getByText('Rui')).toBeInTheDocument();
    expect(b.getByText('Leo')).toBeInTheDocument();
    // Caught hider's time (11:40) shows on the board.
    expect(b.getByText('11:40')).toBeInTheDocument();
  });

  it('calls onPlayAgain when the primary button is pressed', async () => {
    const onPlayAgain = vi.fn();
    render(<GameOver summary={summary()} onPlayAgain={onPlayAgain} />);
    await userEvent.click(screen.getByRole('button', { name: 'Play again' }));
    expect(onPlayAgain).toHaveBeenCalledOnce();
  });

  it('shares the result via the native share sheet where present', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });

    render(<GameOver summary={summary()} onPlayAgain={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Share result/ }));

    expect(share).toHaveBeenCalledOnce();
    const arg = share.mock.calls[0]?.[0] as { text: string };
    expect(arg.text).toContain('HIDERS WIN');
    expect(arg.text).toContain('1 catch');
  });

  it('copies the result to the clipboard when there is no share sheet', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<GameOver summary={summary()} onPlayAgain={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /Share result/ }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });
});
