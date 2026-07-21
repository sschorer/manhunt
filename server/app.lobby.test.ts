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
} from './live/index.ts';
import { createMemoryLobby, type Game } from './lobby/rooms.ts';

type LobbyAck =
  | { ok: true; game: Game; playerId: string }
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
    lobby: createMemoryLobby(),
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

/** Resolve on the first matching event, ignoring earlier in-flight broadcasts. */
function waitUntil<T = unknown>(
  socket: Socket,
  event: string,
  match: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T): void => {
      if (!match(payload)) return;
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

describe('lobby over the socket', () => {
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

  it('creates a room and returns a join code', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url);

    const ack = (await host.emitWithAck('create_game', { name: 'Ada' })) as LobbyAck;
    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected create_game to succeed');
    expect(ack.game.roomCode).toMatch(/^[A-Z0-9]{4}$/);
    expect(ack.game.players[0]).toMatchObject({ name: 'Ada', isHost: true });
    // The manager holds the room under the returned id.
    expect(handle.lobby.get(ack.game.id)?.roomCode).toBe(ack.game.roomCode);
  });

  it('rejects creating a room without a name', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url);

    const ack = (await host.emitWithAck('create_game', {})) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected failure');
    expect(ack.code).toBe('name_required');
  });

  it('runs the full flow: join, assign role, ready, host starts', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url);
    const guest = await open(booted.url);

    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const { roomCode } = created.game;

    // The host is already subscribed, so joining broadcasts a lobby_update to it.
    const hostSawJoin = waitFor<{ game: Game }>(host, 'lobby_update');
    const joined = (await guest.emitWithAck('join_game', { roomCode, name: 'Guest' })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');
    expect(joined.game.players.map((p) => p.name)).toEqual(['Host', 'Guest']);
    expect((await hostSawJoin).game.players).toHaveLength(2);

    // Guest switches to hunter; the host sees the update. Then back to hider so
    // both sides are represented — canStart requires a hunter and a hider.
    const hostSawRole = waitUntil<{ game: Game }>(
      host,
      'lobby_update',
      (p) => p.game.players.find((x) => x.name === 'Guest')?.role === 'hunter',
    );
    const roled = (await guest.emitWithAck('set_role', { role: 'hunter' })) as LobbyAck;
    if (!roled.ok) throw new Error('set_role failed');
    expect((await hostSawRole).game.players.find((p) => p.name === 'Guest')?.role).toBe('hunter');
    await guest.emitWithAck('set_role', { role: 'hider' });

    // Both ready up.
    await host.emitWithAck('set_ready', { ready: true });
    await guest.emitWithAck('set_ready', { ready: true });

    // Host starts; everyone in the room is told the game is active.
    const guestSawStart = waitUntil<{ game: Game }>(
      guest,
      'lobby_update',
      (p) => p.game.status === 'active',
    );
    const started = (await host.emitWithAck('start_game', {})) as LobbyAck;
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('start failed');
    expect(started.game.status).toBe('active');
    expect((await guestSawStart).game.status).toBe('active');
  });

  it('lets only the host start the game', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url);
    const guest = await open(booted.url);

    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    await guest.emitWithAck('join_game', { roomCode: created.game.roomCode, name: 'Guest' });
    await host.emitWithAck('set_ready', { ready: true });
    await guest.emitWithAck('set_ready', { ready: true });

    const ack = (await guest.emitWithAck('start_game', {})) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected non-host start to fail');
    expect(ack.code).toBe('not_host');
    expect(handle.lobby.get(created.game.id)?.status).toBe('lobby');
  });

  it('drops a player and broadcasts when they disconnect', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url);
    const guest = await open(booted.url);

    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    await guest.emitWithAck('join_game', { roomCode: created.game.roomCode, name: 'Guest' });

    // Wait until the host has observed the guest present, so the leave broadcast
    // (not the earlier join broadcast) is what we assert on.
    const hostSawLeave = waitUntil<{ game: Game }>(
      host,
      'lobby_update',
      (p) => p.game.players.length === 1,
    );
    guest.close();
    const after = await hostSawLeave;
    expect(after.game.players.map((p) => p.name)).toEqual(['Host']);
  });

  it('lets a player leave the room without disconnecting the socket', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url);
    const guest = await open(booted.url);

    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    await guest.emitWithAck('join_game', { roomCode: created.game.roomCode, name: 'Guest' });

    const hostSawLeave = waitUntil<{ game: Game }>(
      host,
      'lobby_update',
      (p) => p.game.players.length === 1,
    );
    const ack = (await guest.emitWithAck('leave_game', {})) as { ok: boolean };
    expect(ack.ok).toBe(true);
    expect((await hostSawLeave).game.players.map((p) => p.name)).toEqual(['Host']);
    // The socket stays open — only the lobby membership was dropped.
    expect(guest.connected).toBe(true);
  });

  it('never strands a ghost when one socket moves to another room', async () => {
    const booted = await bootServer();
    handle = booted.handle;
    const host = await open(booted.url); // owns room A
    const mover = await open(booted.url); // owns room B, then joins A

    const a = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    const b = (await mover.emitWithAck('create_game', { name: 'Mover' })) as LobbyAck;
    if (!a.ok || !b.ok) throw new Error('create failed');

    const joined = (await mover.emitWithAck('join_game', {
      roomCode: a.game.roomCode,
      name: 'Mover',
    })) as LobbyAck;
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('join failed');
    expect(joined.game.players.map((p) => p.name)).toEqual(['Host', 'Mover']);
    // Room B held only the mover, so dropping the stale membership emptied and
    // removed it — no ghost player left behind.
    expect(handle.lobby.get(b.game.id)).toBeUndefined();
  });
});
