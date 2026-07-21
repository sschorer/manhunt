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

  it('writes a position and fans out game_state to everyone in the game', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const hunter = connect(booted.url);
    const hider = connect(booted.url);
    clients.push(hunter, hider);
    await Promise.all([waitFor(hunter, 'connect'), waitFor(hider, 'connect')]);

    // The hunter joins the game room and awaits the ack.
    const ack = (await hunter.emitWithAck('join', { gameId: 'g1' })) as { ok: boolean };
    expect(ack).toEqual({ ok: true });

    // The hider reports a position; the hunter should receive the fan-out.
    const received = waitFor<GameStateMessage>(hunter, 'game_state');
    hider.emit('position_update', { gameId: 'g1', playerId: 'hider-1', lat: 52.37, lng: 4.9 });

    const state = await received;
    expect(state.gameId).toBe('g1');
    expect(state.positions['hider-1']).toMatchObject({ lat: 52.37, lng: 4.9 });
    expect(typeof state.positions['hider-1']?.recordedAt).toBe('string');
  });

  it('ignores malformed position updates', async () => {
    const booted = await bootServer();
    handle = booted.handle;

    const client = connect(booted.url);
    clients.push(client);
    await waitFor(client, 'connect');
    await client.emitWithAck('join', { gameId: 'g2' });

    let got = false;
    client.on('game_state', () => {
      got = true;
    });
    // Missing playerId / non-numeric coords — dropped, no broadcast.
    client.emit('position_update', { gameId: 'g2', lat: 'nope' });
    client.emit('position_update', { playerId: 'x', lat: 1, lng: 2 });

    // Give the server a moment; nothing should have been emitted.
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBe(false);
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
