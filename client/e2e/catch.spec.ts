import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

// Drives the full catch flow against the real production server (server/index.ts)
// the way a client would: host a room, join as hiders, start the match, report
// positions, then claim catches. The server verifies the catch radius server-side
// (BACKLOG.md #12) — a claim on a far hider is rejected out of range, while a
// claim on a nearby hider confirms and flips that hider to a hunter. Two separate
// hiders (each reporting once) keep every fix plausible: moving one player from
// far to near in milliseconds would trip the tick engine's anti-teleport guard.
const PORT = process.env.E2E_PORT || 3000;
const url = `http://127.0.0.1:${PORT}`;

// The production server uses the default catch radius (15 m); keep the positions
// well inside/outside it so the assertions don't ride the boundary.
const BASE = { lat: 52.3731, lng: 4.8922 };
function northOf(meters: number): { lat: number; lng: number } {
  return { lat: BASE.lat + meters / 111_320, lng: BASE.lng };
}

interface Player {
  id: string;
  role: 'hunter' | 'hider';
}
interface Game {
  id: string;
  roomCode: string;
  players: Player[];
}
type LobbyAck =
  | { ok: true; game: Game; playerId: string }
  | { ok: false; error: string; code?: string };

interface CatchConfirmed {
  gameId: string;
  hunterId: string;
  targetId: string;
  at: string;
}
type CatchAck =
  | { ok: true; catch: CatchConfirmed }
  | { ok: false; error: string; code?: string };

interface GameState {
  gameId: string;
  positions: Record<string, { lat: number; lng: number }>;
}

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

function waitUntil<T>(socket: Socket, event: string, match: (payload: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T): void => {
      if (!match(payload)) return;
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

test('verifies the catch radius server-side and flips the caught hider to a hunter', async () => {
  const hunter = io(url, { transports: ['websocket'], reconnection: false });
  const hiderFar = io(url, { transports: ['websocket'], reconnection: false });
  const hiderNear = io(url, { transports: ['websocket'], reconnection: false });
  const sockets = [hunter, hiderFar, hiderNear];

  try {
    await Promise.all(sockets.map((s) => waitFor(s, 'connect')));

    // Stand up an active game: host (hunter) + two hiders, all ready, started.
    const created = (await hunter.emitWithAck('create_game', { name: 'Hunter' })) as LobbyAck;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');
    const { roomCode, id: gameId } = created.game;
    const hunterId = created.playerId;

    const joinedFar = (await hiderFar.emitWithAck('join_game', { roomCode, name: 'Far' })) as LobbyAck;
    const joinedNear = (await hiderNear.emitWithAck('join_game', { roomCode, name: 'Near' })) as LobbyAck;
    if (!joinedFar.ok || !joinedNear.ok) throw new Error('join failed');
    const farId = joinedFar.playerId;
    const nearId = joinedNear.playerId;

    await hunter.emitWithAck('set_ready', { ready: true });
    await hiderFar.emitWithAck('set_ready', { ready: true });
    await hiderNear.emitWithAck('set_ready', { ready: true });
    await hunter.emitWithAck('start_game', {});

    // Each player reports once: hunter at BASE, one hider ~5 m away, one ~500 m away.
    const allStored = waitUntil<GameState>(
      hiderNear,
      'game_state',
      (p) => Boolean(p.positions[hunterId] && p.positions[farId] && p.positions[nearId]),
    );
    hunter.emit('position_update', { gameId, playerId: hunterId, ...BASE });
    hiderFar.emit('position_update', { gameId, playerId: farId, ...northOf(500) });
    hiderNear.emit('position_update', { gameId, playerId: nearId, ...northOf(5) });
    await allStored;

    // The far hider is out of catch range — the claim is rejected, no state change.
    const far = (await hunter.emitWithAck('claim_catch', {
      gameId,
      hunterId,
      targetId: farId,
    })) as CatchAck;
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.code).toBe('out_of_range');

    // The near hider is within range — the claim confirms and flips them to a hunter.
    const nearSaw = waitFor<CatchConfirmed>(hiderNear, 'catch_confirmed');
    const roleFlipped = waitUntil<{ game: Game }>(
      hiderNear,
      'lobby_update',
      (p) => p.game.players.find((x) => x.id === nearId)?.role === 'hunter',
    );
    const near = (await hunter.emitWithAck('claim_catch', {
      gameId,
      hunterId,
      targetId: nearId,
    })) as CatchAck;
    expect(near.ok).toBe(true);

    const event = await nearSaw;
    expect(event).toMatchObject({ gameId, hunterId, targetId: nearId });

    const flipped = await roleFlipped;
    expect(flipped.game.players.find((p) => p.id === nearId)?.role).toBe('hunter');
  } finally {
    for (const s of sockets) s.close();
  }
});
