import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';

// Drives the claim_catch → catch_confirmed contract against the real production
// server (server/index.ts) the same way a client would — the transport half of
// the catch flow, independent of the rules engine (catch-radius verification and
// role switch are BACKLOG.md #12).
const PORT = process.env.E2E_PORT || 3000;
const url = `http://127.0.0.1:${PORT}`;

interface CatchConfirmed {
  gameId: string;
  hunterId: string;
  targetId: string;
  at: string;
}

type CatchAck =
  | { ok: true; catch: CatchConfirmed }
  | { ok: false; error: string; code?: string };

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

test('confirms a valid catch to everyone in the game and rejects a malformed one', async () => {
  const hunter = io(url, { transports: ['websocket'], reconnection: false });
  const hider = io(url, { transports: ['websocket'], reconnection: false });

  try {
    await Promise.all([waitFor(hunter, 'connect'), waitFor(hider, 'connect')]);
    await hunter.emitWithAck('join', { gameId: 'e2e-catch' });
    await hider.emitWithAck('join', { gameId: 'e2e-catch' });

    const hiderSaw = waitFor<CatchConfirmed>(hider, 'catch_confirmed');
    const ack = (await hunter.emitWithAck('claim_catch', {
      gameId: 'e2e-catch',
      hunterId: 'hunter',
      targetId: 'hider',
    })) as CatchAck;
    expect(ack.ok).toBe(true);

    const event = await hiderSaw;
    expect(event).toMatchObject({ gameId: 'e2e-catch', hunterId: 'hunter', targetId: 'hider' });

    // A malformed claim is rejected with an error ack.
    const bad = (await hunter.emitWithAck('claim_catch', { gameId: 'e2e-catch' })) as CatchAck;
    expect(bad.ok).toBe(false);
  } finally {
    hunter.close();
    hider.close();
  }
});
