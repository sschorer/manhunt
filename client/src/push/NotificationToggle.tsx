import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { socket as defaultSocket } from '../socket.ts';
import type { GameConnection } from '../transport/gameConnection.ts';
import {
  connectionTransport,
  disablePush,
  enablePush,
  isPushSupported,
  socketTransport,
  type PushTransport,
} from './push.ts';
import './NotificationToggle.css';

/** Where the toggle currently sits, driving the label and any hint shown. */
type ToggleStatus = 'idle' | 'busy' | 'on' | 'denied' | 'disabled' | 'unsupported' | 'error';

/** The hint shown under the button after a non-success outcome. */
const HINTS: Partial<Record<ToggleStatus, string>> = {
  denied: 'Notifications are blocked — enable them for this site in your browser settings.',
  disabled: 'Push notifications are not configured on this server.',
  unsupported: "This browser can't show notifications.",
  error: "Couldn't enable notifications. Try again.",
};

export interface NotificationToggleProps {
  /** The old server's shared socket, used when there is no Game socket. */
  socket?: Socket;
  /** The Game's own socket on the Worker backend, which the subscription goes over. */
  connection?: GameConnection | null;
}

/**
 * Opt-in control for Web Push. Rendered once the player is in a Game — the server
 * files the subscription against the Seat the connection speaks for — it requests
 * notification permission and registers the browser's push subscription so the
 * server can alert the player to key events (caught, reveal, game over) even with
 * the app backgrounded.
 *
 * The whole control disappears on a browser without the Push API, so it never
 * dangles a button that can't work. Every failure is surfaced as a short hint
 * rather than thrown.
 */
export default function NotificationToggle({ socket = defaultSocket, connection }: NotificationToggleProps) {
  // A browser with no Push API can't do any of this — render nothing at all.
  if (!isPushSupported()) return null;

  // On the Worker backend the Game's own socket carries the subscription; the
  // Lobby has one by the time this renders. Otherwise it is the old server.
  return <SupportedToggle transport={connection ? connectionTransport(connection) : socketTransport(socket)} />;
}

/** Resting status on mount: already-blocked permission shows the denied hint. */
function initialStatus(): ToggleStatus {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied'
    ? 'denied'
    : 'idle';
}

/** The interactive toggle, mounted only once the Push API is known to exist. */
function SupportedToggle({ transport }: { transport: PushTransport }) {
  const [status, setStatus] = useState<ToggleStatus>(initialStatus);

  const enable = async (): Promise<void> => {
    setStatus('busy');
    const result = await enablePush(transport);
    setStatus(result.ok ? 'on' : result.reason);
  };

  const disable = async (): Promise<void> => {
    // Drop the browser subscription and tell the server to forget us, then fall
    // back to the idle state so the player can opt in again later.
    await disablePush(transport);
    setStatus('idle');
  };

  if (status === 'on') {
    return (
      <div className="push-toggle push-toggle--on">
        <span role="status">🔔 Game alerts on</span>
        <button type="button" className="push-toggle__off" onClick={disable}>
          Turn off
        </button>
      </div>
    );
  }

  const hint = HINTS[status];

  return (
    <div className="push-toggle">
      <button
        type="button"
        className="btn btn--ghost push-toggle__btn"
        onClick={enable}
        disabled={status === 'busy' || status === 'denied'}
      >
        {status === 'busy' ? 'Enabling…' : 'Enable game alerts'}
      </button>
      {hint ? (
        <p className="push-toggle__hint" role="alert">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
