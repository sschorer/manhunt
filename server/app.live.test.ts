import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createServer, type ServerHandle } from './app.ts';
import {
  createLocalBroadcaster,
  createMemoryPositionStore,
  type GameStateMessage,
} from './live/index.ts';

/** Boot the real server on an ephemeral port with an in-memory live state. */
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
  await once(handle.httpServer, 'listening'); // node EventEmitter — safe
  const { port } = handle.httpServer.address() as AddressInfo;
  return { handle, url: `http://127.0.0.1:${port}` };
}

function connect(url: string): Socket {
  return ioClient(url, { transports: ['websocket'], reconnection: false });
}

/** Await a socket.io-client event (its Emitter isn't a node EventEmitter). */
function waitFor<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

describe('live position tick over the socket', () => {
  let handle: ServerHandle;
  const clients: Socket[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    handle.io.close();
    handle.httpServer.close();
    await once(handle.httpServer, 'close');
    await handle.liveState.close();
  });

  it('writes a position and fans out game_state to others in the game', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const runner = connect(booted.url);
    const watcher = connect(booted.url);
    clients.push(runner, watcher);
    await Promise.all([waitFor(runner, 'connect'), waitFor(watcher, 'connect')]);

    // Both join with their identity (game, player, role) and await the ack.
    const ack = (await runner.emitWithAck('join', {
      gameId: 'g1',
      playerId: 'hider-1',
      role: 'hider',
    })) as { ok: boolean };
    expect(ack).toEqual({ ok: true });
    await watcher.emitWithAck('join', { gameId: 'g1', playerId: 'hider-2', role: 'hider' });

    // The runner reports only coordinates; identity comes from its join, so the
    // stored position is keyed by the bound playerId, not anything in the payload.
    const received = waitFor<GameStateMessage>(watcher, 'game_state');
    runner.emit('position_update', { lat: 52.37, lng: 4.9 });

    const state = await received;
    expect(state.gameId).toBe('g1');
    expect(state.positions['hider-1']).toMatchObject({ lat: 52.37, lng: 4.9 });
    expect(typeof state.positions['hider-1']?.recordedAt).toBe('string');
    // The server-only role marker is never leaked to clients.
    expect('role' in (state.positions['hider-1'] ?? {})).toBe(false);
  });

  it('does not send hider coordinates to a hunter', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const hunter = connect(booted.url);
    const hider = connect(booted.url);
    clients.push(hunter, hider);
    await Promise.all([waitFor(hunter, 'connect'), waitFor(hider, 'connect')]);
    await hunter.emitWithAck('join', { gameId: 'g3', playerId: 'seeker', role: 'hunter' });
    await hider.emitWithAck('join', { gameId: 'g3', playerId: 'runner', role: 'hider' });

    // The hunter is in the room, so it receives the fan-out — but the hider's
    // position must be filtered out of what it sees.
    const received = waitFor<GameStateMessage>(hunter, 'game_state');
    hider.emit('position_update', { lat: 52.1, lng: 4.3 });

    const state = await received;
    expect(state.positions['runner']).toBeUndefined();
    expect(Object.keys(state.positions)).toHaveLength(0);
  });

  it('rejects a position update from a socket that has not joined', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const other = connect(booted.url);
    const rogue = connect(booted.url);
    clients.push(other, rogue);
    await Promise.all([waitFor(other, 'connect'), waitFor(rogue, 'connect')]);
    await other.emitWithAck('join', { gameId: 'g4', playerId: 'p1', role: 'hider' });

    let got = false;
    other.on('game_state', () => {
      got = true;
    });
    // rogue never joined — it has no identity, so its update is ignored and
    // can't inject a position into g4.
    rogue.emit('position_update', { lat: 1, lng: 2 });

    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBe(false);
  });

  it('ignores malformed position updates', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const client = connect(booted.url);
    clients.push(client);
    await waitFor(client, 'connect');
    await client.emitWithAck('join', { gameId: 'g2', playerId: 'p1', role: 'hider' });

    let got = false;
    client.on('game_state', () => {
      got = true;
    });
    // Non-numeric / missing coords, and coordinates outside the valid
    // geographic range — all dropped, no broadcast.
    client.emit('position_update', { lat: 'nope' });
    client.emit('position_update', { lng: 2 });
    client.emit('position_update', { lat: 91, lng: 0 });
    client.emit('position_update', { lat: 0, lng: 200 });

    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBe(false);
  });

  it('throttles position updates faster than the tick cadence', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const runner = connect(booted.url);
    clients.push(runner);
    await waitFor(runner, 'connect');
    await runner.emitWithAck('join', { gameId: 'g5', playerId: 'p1', role: 'hider' });

    let count = 0;
    runner.on('game_state', () => {
      count += 1;
    });
    // Two updates back-to-back: the first is accepted, the second arrives well
    // inside the minimum interval and is dropped.
    runner.emit('position_update', { lat: 1, lng: 2 });
    runner.emit('position_update', { lat: 3, lng: 4 });

    await new Promise((r) => setTimeout(r, 150));
    expect(count).toBe(1);
  });
});
