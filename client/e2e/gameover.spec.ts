import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

// Drives a full match to its end against the real production server the way a
// client would: host a room, join as a hider, start, close in and catch the last
// hider. Catching the final hider is a win condition (BACKLOG.md #15) — the
// hunters win (`all_caught`) — so the server ends the game and broadcasts
// `game_over` with the summary the end screen renders (BACKLOG.md #19).
const PORT = process.env.E2E_PORT || 3000;
const url = `http://127.0.0.1:${PORT}`;

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

interface HiderOutcome {
  playerId: string;
  name: string;
  caught: boolean;
  survivalMs: number;
}
interface GameSummary {
  gameId: string;
  winner: 'hunters' | 'hiders';
  reason: 'all_caught' | 'timer';
  durationMs: number;
  catches: { hunterId: string; targetId: string; at: string }[];
  hiders: HiderOutcome[];
}
interface GameOver {
  gameId: string;
  summary: GameSummary;
}
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

test('ends the game and broadcasts the summary when the last hider is caught', async () => {
  const hunter = io(url, { transports: ['websocket'], reconnection: false });
  const hider = io(url, { transports: ['websocket'], reconnection: false });
  const sockets = [hunter, hider];

  try {
    await Promise.all(sockets.map((s) => waitFor(s, 'connect')));

    // Stand up an active game: host (hunter) + one hider, both ready, started.
    const created = (await hunter.emitWithAck('create_game', { name: 'Hunter' })) as LobbyAck;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');
    const { roomCode, id: gameId } = created.game;
    const hunterId = created.playerId;

    const joined = (await hider.emitWithAck('join_game', { roomCode, name: 'Ana' })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');
    const hiderId = joined.playerId;

    await hunter.emitWithAck('set_ready', { ready: true });
    await hider.emitWithAck('set_ready', { ready: true });
    await hunter.emitWithAck('start_game', {});

    // Both report a position within the catch radius (~5 m apart).
    const stored = waitUntil<GameState>(
      hider,
      'game_state',
      (p) => Boolean(p.positions[hunterId] && p.positions[hiderId]),
    );
    hunter.emit('position_update', { gameId, playerId: hunterId, ...BASE });
    hider.emit('position_update', { gameId, playerId: hiderId, ...northOf(5) });
    await stored;

    // Catching the only hider is the last-hider win — the server ends the game.
    const over = waitFor<GameOver>(hider, 'game_over');
    const caught = await hunter.emitWithAck('claim_catch', { gameId, hunterId, targetId: hiderId });
    expect((caught as { ok: boolean }).ok).toBe(true);

    const event = await over;
    expect(event.gameId).toBe(gameId);
    expect(event.summary.winner).toBe('hunters');
    expect(event.summary.reason).toBe('all_caught');
    expect(event.summary.catches).toHaveLength(1);
    expect(event.summary.hiders).toEqual([
      expect.objectContaining({ playerId: hiderId, name: 'Ana', caught: true }),
    ]);
  } finally {
    for (const s of sockets) s.close();
  }
});
