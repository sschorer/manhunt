import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

// Exercises the lobby against the real production server booted by the
// Playwright webServer (server/index.ts) — same in-process fallback as the
// other e2e specs, no DB/Redis required.
const PORT = process.env.E2E_PORT || 3000;
const url = `http://127.0.0.1:${PORT}`;

interface Player {
  id: string;
  name: string;
  role: 'hunter' | 'hider';
  ready: boolean;
  isHost: boolean;
}
interface Game {
  id: string;
  roomCode: string;
  status: 'lobby' | 'active' | 'ended';
  players: Player[];
}
type LobbyAck =
  | { ok: true; game: Game; playerId: string }
  | { ok: false; error: string; code?: string };

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

test('runs the full lobby lifecycle over the socket', async () => {
  const host = io(url, { transports: ['websocket'], reconnection: false });
  const guest = io(url, { transports: ['websocket'], reconnection: false });

  try {
    await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);

    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('create failed');
    const { roomCode } = created.game;
    expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

    const joined = (await guest.emitWithAck('join_game', { roomCode, name: 'Guest' })) as LobbyAck;
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('join failed');
    expect(joined.game.players).toHaveLength(2);

    await host.emitWithAck('set_ready', { ready: true });
    await guest.emitWithAck('set_ready', { ready: true });

    const guestSawStart = waitFor<{ game: Game }>(guest, 'lobby_update');
    const started = (await host.emitWithAck('start_game', {})) as LobbyAck;
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('start failed');
    expect(started.game.status).toBe('active');
    expect((await guestSawStart).game.status).toBe('active');
  } finally {
    host.close();
    guest.close();
  }
});

test('creates a game from the UI and shows the room code', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(/Connected to server/, { timeout: 15_000 });

  await page.getByLabel(/your name/i).fill('Ada');
  await page.getByRole('button', { name: /create new game/i }).click();

  // The room-code chip shows a 4-character unambiguous code.
  const code = page.locator('.room-code__value');
  await expect(code).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /start game/i })).toBeVisible();
});
