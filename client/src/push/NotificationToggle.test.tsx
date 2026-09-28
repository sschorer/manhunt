import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GameConnection } from '../transport/gameConnection.ts';
import type { PushEnableResult } from './push.ts';

// Drive the component through the push module's two seams: support detection and
// the enable flow. Everything else (permissions, service worker) lives behind
// enablePush, which we stub per test.
const { isPushSupported, enablePush, disablePush, connectionTransport } = vi.hoisted(() => ({
  isPushSupported: vi.fn(() => true),
  enablePush: vi.fn<() => Promise<PushEnableResult>>(),
  disablePush: vi.fn<() => Promise<void>>(),
  connectionTransport: vi.fn(() => ({ kind: 'game socket' })),
}));

vi.mock('./push.ts', () => ({
  isPushSupported,
  enablePush,
  disablePush,
  connectionTransport,
}));

import NotificationToggle from './NotificationToggle.tsx';

/** The Game's own socket, which the subscription would go over. */
const connection = { request: vi.fn() } as unknown as GameConnection;

beforeEach(() => {
  isPushSupported.mockReturnValue(true);
  enablePush.mockReset();
  disablePush.mockReset();
  disablePush.mockResolvedValue(undefined);
  connectionTransport.mockClear();
});

afterEach(() => cleanup());

describe('<NotificationToggle />', () => {
  it('renders nothing when the browser lacks the Push API', () => {
    isPushSupported.mockReturnValue(false);
    const { container } = render(<NotificationToggle connection={connection} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('enables alerts and confirms on success', async () => {
    enablePush.mockResolvedValue({ ok: true });
    render(<NotificationToggle connection={connection} />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    expect(enablePush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/game alerts on/i));
    // The enable button is gone; a "Turn off" control replaces it.
    expect(screen.queryByRole('button', { name: /enable game alerts/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('turns alerts back off and returns to the idle prompt', async () => {
    enablePush.mockResolvedValue({ ok: true });
    render(<NotificationToggle connection={connection} />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /turn off/i }));

    expect(disablePush).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /enable game alerts/i })).toBeInTheDocument(),
    );
  });

  it('shows a hint when the server has push disabled', async () => {
    enablePush.mockResolvedValue({ ok: false, reason: 'disabled' });
    render(<NotificationToggle connection={connection} />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not configured/i));
    // The button is still there to try again.
    expect(screen.getByRole('button', { name: /enable game alerts/i })).toBeInTheDocument();
  });

  it("renders nothing before the Game's own socket is there", () => {
    const { container } = render(<NotificationToggle connection={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("subscribes over the Game's own socket", async () => {
    enablePush.mockResolvedValue({ ok: true });
    render(<NotificationToggle connection={connection} />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    expect(connectionTransport).toHaveBeenCalledWith(connection);
    expect(enablePush).toHaveBeenCalledWith({ kind: 'game socket' });
  });

  it('shows a retry hint on an error', async () => {
    enablePush.mockResolvedValue({ ok: false, reason: 'error' });
    render(<NotificationToggle connection={connection} />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/try again/i));
  });
});
