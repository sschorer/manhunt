import { socket } from '../socket.ts';
import { useTracking } from '../gps/useTracking.ts';
import type { GpsStatus } from '../gps/useGpsCapture.ts';
import type { Game } from '../lobby/types.ts';
import './ActiveGame.css';

/** Map a GPS status to a user-facing message and an indicator state. */
function gpsMessage(status: GpsStatus): { text: string; tone: 'on' | 'warn' | 'off' } {
  switch (status) {
    case 'tracking':
      return { text: 'Sharing your location', tone: 'on' };
    case 'acquiring':
      return { text: 'Getting your location…', tone: 'warn' };
    case 'unavailable':
      return { text: 'Location signal lost — retrying…', tone: 'warn' };
    case 'denied':
      return { text: 'Location access denied. Enable it to play.', tone: 'off' };
    case 'unsupported':
      return { text: 'This device has no location support.', tone: 'off' };
    default:
      return { text: 'Location off', tone: 'off' };
  }
}

/**
 * The in-match screen shown once a game goes `active`. Its job for now is to
 * drive GPS capture: mounting it starts `watchPosition` (throttled to the fixed
 * cadence) and holds a screen wake lock, streaming `position_update` ticks to
 * the server. The live map (backlog #9/#18) will grow out of this screen.
 */
export default function ActiveGame({
  game,
  playerId,
  onLeave,
}: {
  game: Game;
  playerId: string | null;
  onLeave: () => void;
}) {
  const tracking = useTracking({
    enabled: true,
    gameId: game.id,
    playerId,
    socket,
  });

  const gps = gpsMessage(tracking.gps);

  return (
    <div className="lobby-card lobby-card--active">
      <h2 className="active-title">Game on!</h2>
      <p className="hint">
        The match has started. The live map is coming next — see the backlog.
      </p>

      <p className="tracking" role="status">
        <span className={`tracking__dot tracking__dot--${gps.tone}`} data-testid="tracking-dot" />
        {gps.text}
      </p>

      {tracking.wakeLock === 'denied' ? (
        <p className="hint tracking__note">
          Keep the screen on so tracking doesn&apos;t pause.
        </p>
      ) : null}

      <button type="button" className="lobby-leave" onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}
