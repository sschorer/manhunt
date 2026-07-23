import { useState } from 'react';
import type { Socket } from 'socket.io-client';
import { socket as defaultSocket } from '../socket.ts';
import { enablePush, isPushSupported } from './push.ts';
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

/**
 * Opt-in control for Web Push (BACKLOG.md #23). Rendered once the player is in a
 * game — the server files a subscription against the caller's game and player —
 * it requests notification permission and registers the browser's push
 * subscription so the server can alert the player to key events (caught, reveal,
 * time) even with the app backgrounded.
 *
 * The whole control disappears on a browser without the Push API, so it never
 * dangles a button that can't work. Every failure is surfaced as a short hint
 * rather than thrown.
 */
export default function NotificationToggle({ socket = defaultSocket }: { socket?: Socket }) {
  // A browser with no Push API can't do any of this — render nothing at all.
  if (!isPushSupported()) return null;

  return <SupportedToggle socket={socket} />;
}

function initialStatus(): ToggleStatus {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied'
    ? 'denied'
    : 'idle';
}

function SupportedToggle({ socket }: { socket: Socket }) {
  const [status, setStatus] = useState<ToggleStatus>(initialStatus);

  const enable = async (): Promise<void> => {
    setStatus('busy');
    const result = await enablePush(socket);
    setStatus(result.ok ? 'on' : result.reason);
  };

  if (status === 'on') {
    return (
      <p className="push-toggle push-toggle--on" role="status">
        🔔 Game alerts on
      </p>
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
