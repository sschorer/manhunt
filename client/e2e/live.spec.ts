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

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

test('fans out a position update to other players in the game over the socket', async () => {
  const hunter = io(url, { transports: ['websocket'], reconnection: false });
  const hider = io(url, { transports: ['websocket'], reconnection: false });

  try {
    await Promise.all([waitFor(hunter, 'connect'), waitFor(hider, 'connect')]);

    const ack = (await hunter.emitWithAck('join', { gameId: 'e2e-game' })) as { ok: boolean };
    expect(ack.ok).toBe(true);

    const received = waitFor<GameState>(hunter, 'game_state');
    hider.emit('position_update', {
      gameId: 'e2e-game',
      playerId: 'runner',
      lat: 52.1,
      lng: 4.3,
    });

    const state = await received;
    expect(state.gameId).toBe('e2e-game');
    expect(state.positions.runner).toMatchObject({ lat: 52.1, lng: 4.3 });
  } finally {
    hunter.close();
    hider.close();
  }
});
