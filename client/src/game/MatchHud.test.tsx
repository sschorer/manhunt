import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import MatchHud from './MatchHud.tsx';

afterEach(() => {
  cleanup();
});

describe('<MatchHud /> hunter', () => {
  it('shows the countdown, hider tally, and next ping', () => {
    render(
      <MatchHud
        role="hunter"
        timeLeftMs={11 * 60_000 + 36_000}
        hidersRemaining={3}
        hidersTotal={5}
        nextPingMs={72_000}
      />,
    );
    const hud = screen.getByTestId('hunter-hud');
    expect(within(hud).getByText('11:36')).toBeInTheDocument();
    expect(within(hud).getByText('/ 5')).toBeInTheDocument();
    expect(within(hud).getByText('01:12')).toBeInTheDocument();
  });
});

describe('<MatchHud /> hider', () => {
  it('shows survival time and the reveal countdown while hidden', () => {
    render(<MatchHud role="hider" survivedMs={11 * 60_000 + 36_000} revealed={false} nextPingMs={42_000} />);
    const hud = screen.getByTestId('hider-hud');
    expect(within(hud).getByText('11:36')).toBeInTheDocument();
    expect(within(hud).getByText('Hidden')).toBeInTheDocument();
    expect(within(hud).getByText('00:42')).toBeInTheDocument();
  });

  it('flags the reveal while exposed', () => {
    render(<MatchHud role="hider" survivedMs={0} revealed={true} nextPingMs={42_000} />);
    const hud = screen.getByTestId('hider-hud');
    expect(within(hud).getByText('Revealed')).toBeInTheDocument();
    expect(within(hud).getByText(/just revealed to the hunters/i)).toBeInTheDocument();
  });
});
