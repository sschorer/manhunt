import { useMemo, useState } from 'react';
import { socket } from '../socket.ts';
import { useTracking } from '../gps/useTracking.ts';
import type { GpsStatus } from '../gps/useGpsCapture.ts';
import type { Game, Role } from '../lobby/types.ts';
import GameMap, { type MapMarker } from './GameMap.tsx';
import MatchHud from './MatchHud.tsx';
import { useLivePositions, type LivePositions } from './useLivePositions.ts';
import { useNow } from './useNow.ts';
import { elapsedMs, nextPingMs, timeLeftMs } from './matchClock.ts';
import {
  mergeSightings,
  nearest,
  PROXIMITY_ALERT_M,
  REVEAL_RADIUS_M,
  type Sightings,
} from './proximity.ts';
import { DEFAULT_BOUNDARY_RADIUS_M, type BoundaryCircle, type LngLat } from './geo.ts';
import './ActiveGame.css';

/** How long the hider HUD flags a reveal after a ping exposes them, in ms. */
const REVEAL_FLASH_MS = 6_000;

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

/** Keep only the positions whose owner currently holds `role` in the roster. */
function positionsWithRole(
  positions: LivePositions,
  roleById: Map<string, Role>,
  role: Role,
): LivePositions {
  const out: LivePositions = {};
  for (const [id, pos] of Object.entries(positions)) {
    if (roleById.get(id) === role) out[id] = pos;
  }
  return out;
}

/** "just now" / "3m" — how stale a hider sighting is, for the ghost caption. */
function ageLabel(recordedAt: string, now: number): string {
  const ageMs = Math.max(0, now - Date.parse(recordedAt));
  const minutes = Math.floor(ageMs / 60_000);
  return minutes < 1 ? 'just now' : `${minutes}m`;
}

/**
 * The in-match screen shown once a game goes `active`, rendered from the
 * player's own perspective (BACKLOG.md #18). Mounting it drives GPS capture —
 * `watchPosition` throttled to the fixed cadence plus a screen wake lock,
 * streaming `position_update` ticks — and it composes the live view the mockup
 * calls for: a role-specific HUD (a hunter's countdown, hider tally and next
 * ping; a hider's survival time and reveal countdown), the map with role-coloured
 * pins, and a proximity readout of the nearest opponent.
 *
 * The server is authoritative about visibility: a hunter only receives hider
 * coordinates on a scheduled ping reveal (BACKLOG.md #14), so a hunter's map
 * shows each hider's ageing *last-known* position (a "ghost") accumulated from
 * those reveals, while a hider — who can see the hunters live — tracks them in
 * real time.
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
  const { positions, revealSeq } = useLivePositions(game.id, socket);
  const now = useNow();

  const lat = tracking.last?.lat ?? null;
  const lng = tracking.last?.lng ?? null;
  const self = useMemo<LngLat | null>(
    () => (lat !== null && lng !== null ? { lng, lat } : null),
    [lat, lng],
  );

  // The authoritative role of every player, from the roster the lobby keeps in
  // sync. Falls back to hider — the safe default (a hider sees everyone, so a
  // momentarily-unknown role can't leak a hider's position to a hunter's view).
  const myRole: Role = game.players.find((p) => p.id === playerId)?.role ?? 'hider';
  const roleById = useMemo(() => {
    const map = new Map<string, Role>();
    for (const p of game.players) map.set(p.id, p.role);
    return map;
  }, [game.players]);

  // Everyone but us, as the server permitted us to see them this tick.
  const others = useMemo<LivePositions>(() => {
    const rest: LivePositions = {};
    for (const [id, pos] of Object.entries(positions)) {
      if (id !== playerId) rest[id] = pos;
    }
    return rest;
  }, [positions, playerId]);

  // A hunter accumulates each hider's last-known position from the ping reveals
  // (that's the only time hider coordinates arrive), so the map can keep showing
  // where they were last seen between reveals. Latched during render — the merge
  // returns the same reference when nothing new arrived, so this can't loop.
  const [sightings, setSightings] = useState<Sightings>({});
  if (myRole === 'hunter') {
    const merged = mergeSightings(sightings, positionsWithRole(others, roleById, 'hider'));
    if (merged !== sightings) setSightings(merged);
  }

  // The hider HUD flashes when a ping reveal exposes them. Latch the wall-clock
  // time of the latest reveal during render, then derive "revealed" from how long
  // ago that was — the once-a-second `now` tick clears it without a timer.
  const [lastReveal, setLastReveal] = useState({ seq: 0, at: 0 });
  if (revealSeq !== lastReveal.seq) setLastReveal({ seq: revealSeq, at: now });
  const revealed = myRole === 'hider' && revealSeq > 0 && now - lastReveal.at < REVEAL_FLASH_MS;

  // Anchor a default play area to the first fix and hold it fixed for the match.
  // Set during render (React's endorsed pattern for latching a value the first
  // time it's known). A server-configured per-game boundary replaces this later
  // (BACKLOG.md #11).
  const [boundary, setBoundary] = useState<BoundaryCircle | null>(null);
  if (!boundary && self) {
    setBoundary({ center: self, radiusM: DEFAULT_BOUNDARY_RADIUS_M });
  }

  // Latch the starting hider count so the "3 / 5" tally has a stable denominator
  // even as caught hiders convert to hunters and the numerator falls.
  const [hidersTotal] = useState(() =>
    Math.max(1, game.players.filter((p) => p.role === 'hider').length),
  );
  const hidersRemaining = game.players.filter((p) => p.role === 'hider').length;

  // The nearest opponent: for a hunter, the closest hider we've a sighting for
  // (still a hider — a caught one has flipped sides); for a hider, the closest
  // live hunter. An alert only fires within the proximity radius.
  const opponents = useMemo<LivePositions>(() => {
    if (myRole === 'hunter') {
      const stillHiders: LivePositions = {};
      for (const [id, pos] of Object.entries(sightings)) {
        if (roleById.get(id) === 'hider') stillHiders[id] = pos;
      }
      return stillHiders;
    }
    return positionsWithRole(others, roleById, 'hunter');
  }, [myRole, sightings, others, roleById]);

  const near = nearest(self, opponents);
  const alert = near && near.distanceM <= PROXIMITY_ALERT_M ? near : null;

  const markers = useMemo<MapMarker[]>(() => {
    const list: MapMarker[] = [];
    if (self) list.push({ id: 'self', lngLat: self, team: myRole, kind: 'self' });

    if (myRole === 'hunter') {
      // Fellow hunters, live; hiders as ageing ghosts from the reveals.
      for (const [id, pos] of Object.entries(others)) {
        if (roleById.get(id) === 'hunter') {
          list.push({ id, lngLat: { lng: pos.lng, lat: pos.lat }, team: 'hunter', kind: 'player' });
        }
      }
      for (const [id, pos] of Object.entries(sightings)) {
        if (roleById.get(id) !== 'hider') continue;
        list.push({
          id: `ghost:${id}`,
          lngLat: { lng: pos.lng, lat: pos.lat },
          team: 'hider',
          kind: 'ghost',
          label: `last seen ${ageLabel(pos.recordedAt, now)}`,
        });
      }
    } else {
      // A hider sees everyone live, coloured by their side.
      for (const [id, pos] of Object.entries(others)) {
        list.push({
          id,
          lngLat: { lng: pos.lng, lat: pos.lat },
          team: roleById.get(id) ?? 'hunter',
          kind: 'player',
        });
      }
    }
    return list;
  }, [self, myRole, others, sightings, roleById, now]);

  const alertRing = myRole === 'hunter' && self ? { center: self, radiusM: PROXIMITY_ALERT_M } : null;
  const revealRing = myRole === 'hider' && self ? { center: self, radiusM: REVEAL_RADIUS_M } : null;

  const gps = gpsMessage(tracking.gps);

  return (
    <div className="match">
      {myRole === 'hunter' ? (
        <MatchHud
          role="hunter"
          timeLeftMs={timeLeftMs(game.startedAt, now)}
          hidersRemaining={hidersRemaining}
          hidersTotal={hidersTotal}
          nextPingMs={nextPingMs(game.startedAt, now)}
        />
      ) : (
        <MatchHud
          role="hider"
          survivedMs={elapsedMs(game.startedAt, now)}
          revealed={revealed}
          nextPingMs={nextPingMs(game.startedAt, now)}
        />
      )}

      <GameMap
        markers={markers}
        focus={self}
        boundary={boundary}
        alertRing={alertRing}
        revealRing={revealRing}
      />

      <ProximityAlert role={myRole} near={alert} />

      {myRole === 'hunter' ? (
        <CatchControl game={game} playerId={playerId} targetId={near?.id ?? null} />
      ) : null}

      <p className="tracking" role="status">
        <span className={`tracking__dot tracking__dot--${gps.tone}`} data-testid="tracking-dot" />
        {gps.text}
      </p>

      {tracking.wakeLock === 'denied' ? (
        <p className="hint tracking__note">Keep the screen on so tracking doesn&apos;t pause.</p>
      ) : null}

      <button type="button" className="lobby-leave" onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}

/** The nearest-opponent readout beneath the map — "Hider within 90 m — northeast". */
function ProximityAlert({
  role,
  near,
}: {
  role: Role;
  near: { distanceM: number; direction: string } | null;
}) {
  const quarry = role === 'hunter' ? 'Hider' : 'Hunter';
  if (!near) {
    return (
      <p className={`proximity proximity--${role} proximity--quiet`} role="status">
        No {quarry.toLowerCase()} nearby
      </p>
    );
  }
  return (
    <p className={`proximity proximity--${role}`} role="status">
      <span className="proximity__icon" aria-hidden="true">
        ▲
      </span>
      {quarry} within <strong>{Math.round(near.distanceM)}m</strong> — {near.direction}
    </p>
  );
}

/**
 * The hunter's "scan to catch" action. It claims a catch against the nearest
 * known hider; the server verifies the catch-radius check authoritatively
 * (BACKLOG.md #12) and rejects an out-of-range claim, whose reason we surface.
 * A confirmed catch flips the hider to a hunter and the roster refresh does the
 * rest, so there is nothing to do on success but clear the prompt.
 */
function CatchControl({
  game,
  playerId,
  targetId,
}: {
  game: Game;
  playerId: string | null;
  targetId: string | null;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const scan = async (): Promise<void> => {
    if (!playerId || !targetId) return;
    setPending(true);
    setMessage(null);
    try {
      const ack = (await socket.emitWithAck('claim_catch', {
        gameId: game.id,
        hunterId: playerId,
        targetId,
      })) as { ok: boolean; error?: string };
      setMessage(ack.ok ? 'Caught!' : (ack.error ?? 'Catch failed'));
    } catch {
      setMessage('Could not reach the server.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="scan">
      <button
        type="button"
        className="scan__btn"
        onClick={scan}
        disabled={pending || !targetId}
      >
        🚩 Scan to catch
      </button>
      {message ? (
        <p className="scan__result" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
