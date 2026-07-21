import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

// Exercises the real client GPS capture end to end: a browser host reaches an
// active game, `watchPosition` fires (Playwright feeds it a fixed location), and
// the resulting `position_update` fans out to a second player as `game_state` —
// the same in-process fallback the other specs use, no DB/Redis required.
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
interface GameState {
  gameId: string;
  positions: Record<string, { lat: number; lng: number; recordedAt: string }>;
}

function waitFor<T>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T): void => {
      if (!predicate(payload)) return;
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

// The browser host's captured location (127.0.0.1 is a secure context, so the
// Geolocation API works with the granted permission below).
const HOST_POSITION = { latitude: 52.372, longitude: 4.9041 };
test.use({ geolocation: HOST_POSITION, permissions: ['geolocation'] });

test('the browser client streams its GPS position to other players', async ({ page }) => {
  const guest = io(url, { transports: ['websocket'], reconnection: false }); // a hider

  try {
    await waitFor(guest, 'connect');

    // The host plays through the real UI: create a room, then read its code.
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText(/Connected to server/, { timeout: 15_000 });
    await page.getByLabel(/your name/i).fill('Host');
    await page.getByRole('button', { name: /create new game/i }).click();

    const codeChip = page.locator('.room-code__value');
    await expect(codeChip).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 15_000 });
    const roomCode = (await codeChip.textContent())?.trim() ?? '';

    // A second player joins over the socket and readies up.
    const joined = (await guest.emitWithAck('join_game', { roomCode, name: 'Guest' })) as LobbyAck;
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('join failed');
    const hostId = joined.game.players.find((p) => p.isHost)?.id;
    expect(hostId).toBeTruthy();
    await guest.emitWithAck('set_ready', { ready: true });

    // The host readies through the UI, then starts once the button unlocks.
    await page.getByRole('button', { name: /i'm ready/i }).click();
    const startButton = page.getByRole('button', { name: /start game/i });
    await expect(startButton).toBeEnabled({ timeout: 15_000 });

    // Listen for the host's position before starting, then start the match.
    const hostPosition = waitFor<GameState>(
      guest,
      'game_state',
      (state) => hostId != null && state.positions[hostId] != null,
    );
    await startButton.click();
    await expect(page.getByRole('heading', { name: /game on/i })).toBeVisible();

    const state = await hostPosition;
    expect(state.positions[hostId as string]).toMatchObject({
      lat: HOST_POSITION.latitude,
      lng: HOST_POSITION.longitude,
    });
  } finally {
    guest.close();
  }
});
