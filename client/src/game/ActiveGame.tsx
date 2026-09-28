import { useMemo, useState } from 'react';
import { useConnection, type ConnectionStatus } from '../useConnection.ts';
import type { GameConnection } from '../transport/gameConnection.ts';
import { useTracking } from '../gps/useTracking.ts';
import { MAX_CADENCE_MS, type GpsStatus } from '../gps/useGpsCapture.ts';
import {
  INBOUND_EVENTS,
  type BoundaryWarningEvent,
  type CatchAck,
  type Game,
  type Role,
} from '@manhunt/shared';
import GameMap, { type MapMarker } from './GameMap.tsx';
import MatchHud from './MatchHud.tsx';
import { useBoundaryEvents } from './useBoundaryEvents.ts';
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

/**
 * How long a Boundary warning and an Elimination notice stay on screen, in ms:
 * a little over one position cadence. Long enough that the warning is still up
 * when the next fix — the one that decides between a return and an Elimination
 * — is sent, and short enough that it clears soon after a player is back inside,
 * which the Game forgives without a word.
 */
const BOUNDARY_NOTICE_MS = MAX_CADENCE_MS + 5_000;

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
  connection: gameConnection,
}: {
  game: Game;
  playerId: string | null;
  onLeave: () => void;
  /** The Game's own socket: what carries this player's fixes and the Game's events. */
  connection: GameConnection | null;
}) {
  // Who we are in the roster the Lobby keeps in sync. Our role falls back to
  // hider — the safe default (a hider sees everyone, so a momentarily-unknown
  // role can't leak a hider's position to a hunter's view).
  const me = game.players.find((p) => p.id === playerId);
  const myRole: Role = me?.role ?? 'hider';
  // Eliminated for staying outside the Boundary: we are out of play, and the
  // Game ignores anything we report, so there is nothing left to share.
  const eliminated = me?.eliminated === true;

  const tracking = useTracking({
    enabled: !eliminated,
    gameId: game.id,
    playerId,
    connection: gameConnection,
  });
  const { positions, revealSeq } = useLivePositions(game.id, gameConnection);
  const boundaryEvents = useBoundaryEvents(game.id, gameConnection);
  const connection = useConnection(gameConnection);
  const online = connection === 'connected';
  const now = useNow();

  const lat = tracking.last?.lat ?? null;
  const lng = tracking.last?.lng ?? null;
  const self = useMemo<LngLat | null>(
    () => (lat !== null && lng !== null ? { lng, lat } : null),
    [lat, lng],
  );

  // The authoritative role of every player, from the same roster.
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
  // Still out there: a hider who has neither been caught nor eliminated.
  const hidersRemaining = game.players.filter((p) => p.role === 'hider' && !p.eliminated).length;

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

  /** A notice the Game stamped is shown for one cadence, then fades. */
  const fresh = (at: string | undefined): boolean =>
    at !== undefined && now - Date.parse(at) < BOUNDARY_NOTICE_MS;
  const warned = boundaryEvents.warning && fresh(boundaryEvents.warning.at) ? boundaryEvents.warning : null;
  // Someone else's Elimination: our own is the standing banner below instead.
  const { elimination } = boundaryEvents;
  const othersOut =
    elimination && elimination.playerId !== playerId && fresh(elimination.at)
      ? (game.players.find((p) => p.id === elimination.playerId)?.name ?? null)
      : null;

  const gps = gpsMessage(tracking.gps);

  return (
    <div className="match">
      <SignalBanner status={connection} />
      <BoundaryBanner eliminated={eliminated} warning={warned} othersOut={othersOut} />

      {myRole === 'hunter' ? (
        <MatchHud
          role="hunter"
          timeLeftMs={timeLeftMs(game.startedAt, now, game.rules?.gameDurationMs)}
          hidersRemaining={hidersRemaining}
          hidersTotal={hidersTotal}
          nextPingMs={nextPingMs(game.startedAt, now, game.rules?.pingIntervalMs)}
        />
      ) : (
        <MatchHud
          role="hider"
          survivedMs={elapsedMs(game.startedAt, now)}
          revealed={revealed}
          nextPingMs={nextPingMs(game.startedAt, now, game.rules?.pingIntervalMs)}
        />
      )}

      <GameMap
        markers={markers}
        focus={self}
        boundary={boundary}
        alertRing={alertRing}
        revealRing={revealRing}
        stale={!online}
      />

      <ProximityAlert role={myRole} near={alert} />

      {myRole === 'hunter' ? (
        <CatchControl
          game={game}
          playerId={playerId}
          targetId={near?.id ?? null}
          connection={gameConnection}
        />
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

/**
 * The connection banner shown across the top of a live match when the Game's
 * socket drops (BACKLOG.md #24). The map keeps every player's last-known
 * position on screen — the live view is retained across a drop, it just stops
 * updating — so the banner's job is to say the fixes are now stale and whether
 * we're getting back. Renders nothing while connected.
 */
function SignalBanner({ status }: { status: ConnectionStatus }) {
  if (status === 'connected') return null;
  const reconnecting = status === 'reconnecting';
  return (
    <p className="match__signal" role="status">
      <span className="match__signal-dot" aria-hidden="true" />
      {reconnecting
        ? 'Signal lost — showing last-known positions. Reconnecting…'
        : 'Offline — showing last-known positions.'}
    </p>
  );
}

/**
 * The Boundary banner (`server/CONTEXT.md` "Boundary" and "Elimination"). The
 * Game checks every accepted fix against the Boundary: straying outside warns
 * this player personally, and staying out once their warnings are used up takes
 * them out of play for good — which everyone is told about. Renders nothing for
 * a player who is inside, unwarned, and has seen no recent Elimination.
 */
function BoundaryBanner({
  eliminated,
  warning,
  othersOut,
}: {
  eliminated: boolean;
  warning: BoundaryWarningEvent | null;
  /** The name of another player just eliminated, if any. */
  othersOut: string | null;
}) {
  if (eliminated) {
    return (
      <p className="boundary boundary--out" role="alert">
        You&apos;re out — you stayed outside the boundary.
      </p>
    );
  }
  if (warning) {
    const { metersOutside, warningsRemaining } = warning;
    return (
      <p className="boundary" role="alert">
        <strong>{Math.round(metersOutside)}m</strong> outside the boundary —{' '}
        {warningsRemaining > 0
          ? `${warningsRemaining} warning${warningsRemaining === 1 ? '' : 's'} left.`
          : "head back now or you're out."}
      </p>
    );
  }
  if (!othersOut) return null;
  return (
    <p className="boundary boundary--other" role="status">
      {othersOut} is out — they stayed outside the boundary.
    </p>
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
 * The Hunter's "scan to catch" action. It claims a Catch against the nearest
 * known Hider; the Game decides the Catch radius authoritatively from its own
 * positions (`server/CONTEXT.md` "Catch radius") and rejects an out-of-range or
 * stale claim, whose reason we surface. A confirmed Catch turns that Hider into
 * a Hunter and the roster refresh does the rest, so there is nothing to do on
 * success but say so.
 */
function CatchControl({
  game,
  playerId,
  targetId,
  connection,
}: {
  game: Game;
  playerId: string | null;
  targetId: string | null;
  /** The Game's own socket, which the claim goes over as a request. */
  connection: GameConnection | null;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const scan = async (): Promise<void> => {
    if (!playerId || !targetId || !connection) return;
    setPending(true);
    setMessage(null);
    const claim = { gameId: game.id, hunterId: playerId, targetId };
    try {
      // The Game's own socket times its requests out and never resends them, so
      // a claim is never made twice and a Game that never replies can't leave
      // `pending` stuck with the button disabled for good.
      const ack = await connection.request<CatchAck>(INBOUND_EVENTS.claimCatch, claim);
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
        disabled={pending || !targetId || !connection}
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
