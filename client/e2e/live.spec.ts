import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

// The Playwright webServer boots the real production server (server/index.ts).
// Without REDIS_URL it runs the in-process live-state fallback, so this
// exercises the full position tick → game_state fan-out against the real
// server the same way a client would, no Redis service required.
const PORT = process.env.E2E_PORT || 3000;
const url = `http://127.0.0.1:${PORT}`;

interface GameState {
  gameId: string;
  positions: Record<string, { lat: number; lng: number; recordedAt: string }>;
}
type LobbyAck =
  | { ok: true; game: { id: string; roomCode: string }; playerId: string }
  | { ok: false; error: string; code?: string };

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

test('fans out a position update to other players in the game over the socket', async () => {
  const host = io(url, { transports: ['websocket'], reconnection: false }); // hunter
  const guest = io(url, { transports: ['websocket'], reconnection: false }); // hider

  try {
    await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);

    // Establish a real lobby: position updates are bound to the socket's
    // authoritative membership (a client can't write another player's position).
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');
    const { id: gameId } = created.game;
    const hostId = created.playerId;
    const joined = (await guest.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Guest',
    })) as LobbyAck;
    expect(joined.ok).toBe(true);

    // The host (a hunter) reports a position; the guest (a hider, who sees
    // everyone) receives it in the fan-out.
    const received = waitFor<GameState>(guest, 'game_state');
    host.emit('position_update', { gameId, playerId: hostId, lat: 52.1, lng: 4.3 });

    const state = await received;
    expect(state.gameId).toBe(gameId);
    expect(state.positions[hostId]).toMatchObject({ lat: 52.1, lng: 4.3 });
  } finally {
    host.close();
    guest.close();
  }
});
