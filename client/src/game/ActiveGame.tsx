import { useMemo, useState } from 'react';
import { socket } from '../socket.ts';
import { useTracking } from '../gps/useTracking.ts';
import type { GpsStatus } from '../gps/useGpsCapture.ts';
import type { Game } from '../lobby/types.ts';
import GameMap from './GameMap.tsx';
import { useLivePositions } from './useLivePositions.ts';
import { DEFAULT_BOUNDARY_RADIUS_M, type BoundaryCircle, type LngLat } from './geo.ts';
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
 * The in-match screen shown once a game goes `active`. It drives GPS capture —
 * mounting it starts `watchPosition` (throttled to the fixed cadence) and holds
 * a screen wake lock, streaming `position_update` ticks to the server — and
 * renders the live map: the player's own pin, every other permitted player from
 * the server's fan-out, and the play-area boundary overlaid (backlog #9).
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
  const others = useLivePositions(game.id, socket);

  const lat = tracking.last?.lat ?? null;
  const lng = tracking.last?.lng ?? null;
  const self = useMemo<LngLat | null>(
    () => (lat !== null && lng !== null ? { lng, lat } : null),
    [lat, lng],
  );

  // Anchor a default play area to the first fix and hold it fixed for the match.
  // Set during render (React's endorsed pattern for latching a value the first
  // time it's known) rather than in an effect. A server-configured per-game
  // boundary replaces this later (BACKLOG.md #11).
  const [boundary, setBoundary] = useState<BoundaryCircle | null>(null);
  if (!boundary && self) {
    setBoundary({ center: self, radiusM: DEFAULT_BOUNDARY_RADIUS_M });
  }

  const gps = gpsMessage(tracking.gps);

  return (
    <div className="lobby-card lobby-card--active">
      <h2 className="active-title">Game on!</h2>

      <GameMap self={self} selfId={playerId} others={others} boundary={boundary} />

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
