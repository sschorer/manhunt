import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createServer, type ServerHandle } from './app.ts';
import {
  createBoundaryMonitor,
  createLocalBroadcaster,
  createMemoryPositionStore,
  type BoundaryMonitor,
} from './live/index.ts';
import { createMemoryLobby } from './lobby/rooms.ts';
import type { BoundaryWarningEvent, PlayerEliminatedEvent } from './protocol/messages.ts';

/** A tight play area at the origin so a nearby fix is unambiguously in or out. */
const BOUNDARY = { center: { lat: 0, lng: 0 }, radiusM: 100 };
const INSIDE = { lat: 0, lng: 0 };
// ~1.1 km north of the centre — comfortably outside the 100 m circle.
const OUTSIDE = { lat: 0.01, lng: 0 };

type LobbyAck =
  | { ok: true; game: { id: string; roomCode: string }; playerId: string }
  | { ok: false; error: string; code?: string };

/** Boot the real server with in-memory hot state and an explicit warn policy. */
async function bootServer(
  boundaryMonitor: BoundaryMonitor,
): Promise<{ handle: ServerHandle; url: string }> {
  const handle = createServer({
    staticDir: path.join(os.tmpdir(), 'nope'),
    liveState: {
      store: createMemoryPositionStore(),
      broadcaster: createLocalBroadcaster(),
      close: () => Promise.resolve(),
    },
    lobby: createMemoryLobby(),
    boundaryMonitor,
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

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('boundary enforcement over the socket', () => {
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

  it('warns a player who leaves the area, then eliminates on a continued exit', async () => {
    const booted = await bootServer(createBoundaryMonitor({ warningsBeforeElimination: 1 }));
    handle = booted.handle;

    const host = await open(booted.url);
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create_game failed');
    const { id: gameId, roomCode } = created.game;
    const hostId = created.playerId;

    const boundaryAck = (await host.emitWithAck('set_boundary', { boundary: BOUNDARY })) as LobbyAck;
    expect(boundaryAck.ok).toBe(true);
    expect(handle.lobby.get(gameId)?.boundary).toEqual(BOUNDARY);

    // A second player in the room observes the (room-wide) elimination broadcast.
    const observer = await open(booted.url);
    await observer.emitWithAck('join_game', { roomCode, name: 'Watcher' });

    let observerEliminated: PlayerEliminatedEvent | undefined;
    observer.on('player_eliminated', (e: PlayerEliminatedEvent) => {
      observerEliminated = e;
    });

    // First fix is outside → a personal warning to the offending player only.
    const warned = waitFor<BoundaryWarningEvent>(host, 'boundary_warning');
    host.emit('position_update', { gameId, playerId: hostId, ...OUTSIDE });
    const warning = await warned;
    expect(warning).toMatchObject({
      gameId,
      playerId: hostId,
      warnings: 1,
      warningsRemaining: 0,
    });
    expect(warning.metersOutside).toBeGreaterThan(1000);
    expect(observerEliminated).toBeUndefined();

    // A continued exit (same spot, so the plausibility guard passes) eliminates.
    const eliminated = waitFor<PlayerEliminatedEvent>(observer, 'player_eliminated');
    host.emit('position_update', { gameId, playerId: hostId, ...OUTSIDE });
    const event = await eliminated;
    expect(event).toMatchObject({ gameId, playerId: hostId, reason: 'boundary' });
    expect(typeof event.at).toBe('string');
  });

  it('raises no warning while a player stays inside the area', async () => {
    const booted = await bootServer(createBoundaryMonitor({ warningsBeforeElimination: 1 }));
    handle = booted.handle;

    const host = await open(booted.url);
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create_game failed');
    const { id: gameId } = created.game;
    await host.emitWithAck('set_boundary', { boundary: BOUNDARY });

    let warned = false;
    host.on('boundary_warning', () => {
      warned = true;
    });
    let eliminated = false;
    host.on('player_eliminated', () => {
      eliminated = true;
    });

    host.emit('position_update', { gameId, playerId: created.playerId, ...INSIDE });
    await wait(60);
    expect(warned).toBe(false);
    expect(eliminated).toBe(false);
  });

  it('rejects set_boundary from a non-host and never enforces it', async () => {
    const booted = await bootServer(createBoundaryMonitor());
    handle = booted.handle;

    const host = await open(booted.url);
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create_game failed');

    const guest = await open(booted.url);
    await guest.emitWithAck('join_game', { roomCode: created.game.roomCode, name: 'Guest' });

    const ack = (await guest.emitWithAck('set_boundary', { boundary: BOUNDARY })) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected non-host to be rejected');
    expect(ack.code).toBe('not_host');
    expect(handle.lobby.get(created.game.id)?.boundary).toBeUndefined();
  });

  it('rejects a malformed set_boundary with an error ack', async () => {
    const booted = await bootServer(createBoundaryMonitor());
    handle = booted.handle;

    const host = await open(booted.url);
    await host.emitWithAck('create_game', { name: 'Host' });

    const ack = (await host.emitWithAck('set_boundary', {
      boundary: { center: { lat: 0, lng: 0 }, radiusM: 0 },
    })) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected invalid radius to be rejected');
    expect(ack.code).toBe('invalid_radius');
  });
});
