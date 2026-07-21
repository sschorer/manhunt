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

/** The lobby create/join ack we need to read game/player ids off of. */
type LobbyAck =
  | { ok: true; game: { id: string; roomCode: string }; playerId: string }
  | { ok: false; error: string; code?: string };

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

  it('writes a position and fans out game_state to game members', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const host = connect(booted.url); // hunter
    const guest = connect(booted.url); // hider
    clients.push(host, guest);
    await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);

    // Position updates are bound to the socket's lobby membership, so both
    // players join a real room first.
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const gameId = created.game.id;
    const hostId = created.playerId;
    const joined = (await guest.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Guest',
    })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');

    // The host (a hunter) reports a position; the guest (a hider, who sees
    // everyone) receives it in the fan-out.
    const received = waitFor<GameStateMessage>(guest, 'game_state');
    host.emit('position_update', { gameId, playerId: hostId, lat: 52.37, lng: 4.9 });

    const state = await received;
    expect(state.gameId).toBe(gameId);
    expect(state.positions[hostId]).toMatchObject({ lat: 52.37, lng: 4.9 });
    expect(typeof state.positions[hostId]?.recordedAt).toBe('string');
  });

  it('ignores malformed position updates', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const host = connect(booted.url);
    clients.push(host);
    await waitFor(host, 'connect');
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const gameId = created.game.id;

    let got = false;
    host.on('game_state', () => {
      got = true;
    });
    // Non-numeric coords, and coordinates outside the WGS84 range — dropped by
    // the validator, so no broadcast (not even back to the emitter).
    host.emit('position_update', { gameId, playerId: created.playerId, lat: 'nope' });
    host.emit('position_update', { gameId, playerId: created.playerId, lat: 91, lng: 2 });

    // Ordered barrier on the same socket: once this ack returns, the server has
    // processed (and dropped) the position_updates queued before it — no sleep.
    await host.emitWithAck('set_ready', { ready: true });
    expect(got).toBe(false);
  });

  it('rejects a position update that claims another player’s identity', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const host = connect(booted.url); // hunter
    const guest = connect(booted.url); // hider
    clients.push(host, guest);
    await Promise.all([waitFor(host, 'connect'), waitFor(guest, 'connect')]);

    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const gameId = created.game.id;
    const hostId = created.playerId;
    const joined = (await guest.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Guest',
    })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');

    // The guest spoofs the HOST's id. Identity is bound to the socket's
    // membership, so the update is rejected: no broadcast, and the store never
    // records a position for the victim.
    let broadcast = false;
    host.on('game_state', () => {
      broadcast = true;
    });
    guest.on('game_state', () => {
      broadcast = true;
    });
    guest.emit('position_update', { gameId, playerId: hostId, lat: 1, lng: 2 });

    // Ordered barrier on the emitting socket: the spoofed tick is fully processed
    // (and rejected) by the time this ack returns, so the assertions can't race.
    await guest.emitWithAck('set_ready', { ready: true });
    expect(broadcast).toBe(false);
    expect(await handle.liveState.store.readPositions(gameId)).toEqual({});
  });

  it('does not leak hider coordinates to a hunter (roles from the lobby roster)', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const hunter = connect(booted.url); // the room host is a hunter
    const hider = connect(booted.url);
    clients.push(hunter, hider);
    await Promise.all([waitFor(hunter, 'connect'), waitFor(hider, 'connect')]);

    // A real lobby so the server can resolve each socket's role.
    const created = (await hunter.emitWithAck('create_game', { name: 'Seeker' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const gameId = created.game.id;
    const joined = (await hider.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Runner',
    })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');
    const hiderId = joined.playerId;

    // The hider reports a position. The hunter shares the room and receives a
    // game_state broadcast, but the hider's coordinates are filtered out of it.
    const hunterSaw = waitFor<GameStateMessage>(hunter, 'game_state');
    hider.emit('position_update', { gameId, playerId: hiderId, lat: 52.1, lng: 4.3 });

    const seen = await hunterSaw;
    expect(seen.gameId).toBe(gameId); // the broadcast did reach the hunter…
    expect(seen.positions[hiderId]).toBeUndefined(); // …but without the hider
    expect(Object.keys(seen.positions)).toHaveLength(0);
  });
});
