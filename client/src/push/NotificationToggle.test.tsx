import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PushEnableResult } from './push.ts';

// Drive the component through the push module's two seams: support detection and
// the enable flow. Everything else (permissions, service worker) lives behind
// enablePush, which we stub per test.
const { isPushSupported, enablePush } = vi.hoisted(() => ({
  isPushSupported: vi.fn(() => true),
  enablePush: vi.fn<() => Promise<PushEnableResult>>(),
}));

vi.mock('./push.ts', () => ({ isPushSupported, enablePush }));

// The component defaults to the shared socket; a bare stub keeps it inert here.
vi.mock('../socket.ts', () => ({ socket: {}, createSocket: () => ({}) }));

import NotificationToggle from './NotificationToggle.tsx';

beforeEach(() => {
  isPushSupported.mockReturnValue(true);
  enablePush.mockReset();
});

afterEach(() => cleanup());

describe('<NotificationToggle />', () => {
  it('renders nothing when the browser lacks the Push API', () => {
    isPushSupported.mockReturnValue(false);
    const { container } = render(<NotificationToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('enables alerts and confirms on success', async () => {
    enablePush.mockResolvedValue({ ok: true });
    render(<NotificationToggle />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    expect(enablePush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/game alerts on/i));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a hint when the server has push disabled', async () => {
    enablePush.mockResolvedValue({ ok: false, reason: 'disabled' });
    render(<NotificationToggle />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not configured/i));
    // The button is still there to try again.
    expect(screen.getByRole('button', { name: /enable game alerts/i })).toBeInTheDocument();
  });

  it('shows a retry hint on an error', async () => {
    enablePush.mockResolvedValue({ ok: false, reason: 'error' });
    render(<NotificationToggle />);

    await userEvent.click(screen.getByRole('button', { name: /enable game alerts/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/try again/i));
  });
});
