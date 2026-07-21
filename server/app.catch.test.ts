import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createServer, type ServerHandle } from './app.ts';
import { createLocalBroadcaster, createMemoryPositionStore } from './live/index.ts';
import type { CatchConfirmedEvent } from './protocol/messages.ts';

type CatchAck =
  | { ok: true; catch: CatchConfirmedEvent }
  | { ok: false; error: string; code?: string };

/** Boot the real server on an ephemeral port with in-memory hot state. */
async function bootServer(): Promise<{ handle: ServerHandle; url: string }> {
  const handle = createServer({
    staticDir: path.join(os.tmpdir(), 'nope'),
    liveState: {
      store: createMemoryPositionStore(),
      broadcaster: createLocalBroadcaster(),
      close: () => Promise.resolve(),
    },
  });
  handle.httpServer.listen(0);
  await once(handle.httpServer, 'listening');
  const { port } = handle.httpServer.address() as AddressInfo;
  return { handle, url: `http://127.0.0.1:${port}` };
}

function connect(url: string): Socket {
  return ioClient(url, { transports: ['websocket'], reconnection: false });
}

function waitFor<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

describe('claim_catch → catch_confirmed over the socket', () => {
  let handle: ServerHandle;
  const clients: Socket[] = [];

  async function open(url: string): Promise<Socket> {
    const c = connect(url);
    clients.push(c);
    await waitFor(c, 'connect');
    return c;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    handle.io.close();
    handle.httpServer.close();
    await once(handle.httpServer, 'close');
    await handle.liveState.close();
  });

  it('broadcasts catch_confirmed to everyone in the game on a valid claim', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const hunter = await open(booted.url);
    const hider = await open(booted.url);

    // Both are in the game room (the hunter claims, the hider observes).
    await hunter.emitWithAck('join', { gameId: 'g1' });
    await hider.emitWithAck('join', { gameId: 'g1' });

    const hiderSaw = waitFor<CatchConfirmedEvent>(hider, 'catch_confirmed');
    const ack = (await hunter.emitWithAck('claim_catch', {
      gameId: 'g1',
      hunterId: 'h1',
      targetId: 't1',
    })) as CatchAck;

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected claim to succeed');
    expect(ack.catch).toMatchObject({ gameId: 'g1', hunterId: 'h1', targetId: 't1' });
    expect(typeof ack.catch.at).toBe('string');

    const event = await hiderSaw;
    expect(event).toMatchObject({ gameId: 'g1', hunterId: 'h1', targetId: 't1' });
  });

  it('rejects a malformed claim with an error ack and no broadcast', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const hunter = await open(booted.url);
    await hunter.emitWithAck('join', { gameId: 'g2' });

    let broadcast = false;
    hunter.on('catch_confirmed', () => {
      broadcast = true;
    });

    // Missing targetId.
    const ack = (await hunter.emitWithAck('claim_catch', {
      gameId: 'g2',
      hunterId: 'h1',
    })) as CatchAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected failure');
    expect(ack.code).toBe('target_id_required');

    // A hunter cannot catch themselves.
    const selfAck = (await hunter.emitWithAck('claim_catch', {
      gameId: 'g2',
      hunterId: 'same',
      targetId: 'same',
    })) as CatchAck;
    if (selfAck.ok) throw new Error('expected self-catch to fail');
    expect(selfAck.code).toBe('self_catch');

    await new Promise((r) => setTimeout(r, 50));
    expect(broadcast).toBe(false);
  });
});
