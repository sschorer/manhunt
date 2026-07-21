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
  const watcher = io(url, { transports: ['websocket'], reconnection: false });
  const runner = io(url, { transports: ['websocket'], reconnection: false });

  try {
    await Promise.all([waitFor(watcher, 'connect'), waitFor(runner, 'connect')]);

    // Both players join with their identity; position updates then trust the
    // socket's bound identity, not the payload.
    const ack = (await watcher.emitWithAck('join', {
      gameId: 'e2e-game',
      playerId: 'watcher',
      role: 'hider',
    })) as { ok: boolean };
    expect(ack.ok).toBe(true);
    await runner.emitWithAck('join', { gameId: 'e2e-game', playerId: 'runner', role: 'hider' });

    const received = waitFor<GameState>(watcher, 'game_state');
    runner.emit('position_update', { lat: 52.1, lng: 4.3 });

    const state = await received;
    expect(state.gameId).toBe('e2e-game');
    expect(state.positions.runner).toMatchObject({ lat: 52.1, lng: 4.3 });
  } finally {
    watcher.close();
    runner.close();
  }
});
