import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import {
  createServer,
  type CreateServerOptions,
  type DisconnectTimerApi,
  type ServerHandle,
} from './app.ts';
import { createLocalBroadcaster, createMemoryPositionStore } from './live/index.ts';
import { createMemoryLobby, type Game } from './lobby/rooms.ts';

type LobbyAck =
  | { ok: true; game: Game; playerId: string; resumeToken?: string }
  | { ok: false; error: string; code?: string };

/**
 * A controllable disconnect-grace timer: it records pending removals and fires
 * them on demand, so a test can assert what happens before and after the grace
 * elapses without waiting on the wall clock.
 */
function fakeGraceTimers(): DisconnectTimerApi & { fireAll: () => void; active: () => number } {
  const handlers = new Set<() => void>();
  return {
    setTimeout(handler: () => void) {
      handlers.add(handler);
      return handler;
    },
    clearTimeout(handle: unknown) {
      handlers.delete(handle as () => void);
    },
    fireAll() {
      for (const handler of [...handlers]) {
        handlers.delete(handler);
        handler();
      }
    },
    active() {
      return handlers.size;
    },
  };
}

/** Boot the real server on an ephemeral port with in-memory hot state. */
async function bootServer(
  options: Partial<CreateServerOptions> = {},
): Promise<{ handle: ServerHandle; url: string }> {
  const handle = createServer({
    staticDir: path.join(os.tmpdir(), 'nope'),
    liveState: {
      store: createMemoryPositionStore(),
      broadcaster: createLocalBroadcaster(),
      close: () => Promise.resolve(),
    },
    lobby: createMemoryLobby(),
    ...options,
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

describe('reconnect handling over the socket', () => {
  let handle: ServerHandle;
  const clients: Socket[] = [];

  async function open(url: string): Promise<Socket> {
    const c = connect(url);
    clients.push(c);
    await waitFor(c, 'connect');
    return c;
  }

  /** Create a room, join a guest, and start the match; returns ids and sockets. */
  async function startedGame(url: string): Promise<{
    host: Socket;
    guest: Socket;
    gameId: string;
    guestId: string;
    guestToken: string;
  }> {
    const host = await open(url);
    const guest = await open(url);
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const joined = (await guest.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Guest',
    })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');
    await host.emitWithAck('set_ready', { ready: true });
    await guest.emitWithAck('set_ready', { ready: true });
    const started = (await host.emitWithAck('start_game', {})) as LobbyAck;
    if (!started.ok) throw new Error('start failed');
    return {
      host,
      guest,
      gameId: created.game.id,
      guestId: joined.playerId,
      guestToken: joined.resumeToken ?? '',
    };
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    handle.io.close();
    handle.httpServer.close();
    await once(handle.httpServer, 'close');
    await handle.liveState.close();
  });

  it('holds a dropped player mid-match through the grace period', async () => {
    const timers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers });
    handle = booted.handle;
    const { guest, gameId, guestId } = await startedGame(booted.url);

    guest.close();
    // The socket close registers as a disconnect on the server; poll until its
    // handler has armed the grace timer rather than removed the player outright.
    await viFlush(() => timers.active() === 1);
    expect(handle.lobby.get(gameId)?.players.map((p) => p.id)).toContain(guestId);

    // The grace elapses with no resume — now the player is dropped.
    timers.fireAll();
    expect(handle.lobby.get(gameId)?.players.map((p) => p.id)).not.toContain(guestId);
  });

  it('lets a reconnecting client resume its identity within the grace', async () => {
    const timers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers });
    handle = booted.handle;
    const { guest, gameId, guestId, guestToken } = await startedGame(booted.url);

    guest.close();
    await viFlush(() => timers.active() === 1);

    // A brand-new socket (as the transport gives a reconnect) reclaims the slot.
    const reconnected = await open(booted.url);
    const ack = (await reconnected.emitWithAck('resume', {
      gameId,
      playerId: guestId,
      resumeToken: guestToken,
    })) as LobbyAck;
    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected resume to succeed');
    expect(ack.game.players.map((p) => p.id)).toContain(guestId);
    // Resuming cancelled the pending removal, so the grace firing is now a no-op.
    expect(timers.active()).toBe(0);
    timers.fireAll();
    expect(handle.lobby.get(gameId)?.players.map((p) => p.id)).toContain(guestId);
  });

  it('rejects a resume with the wrong token — the playerId alone is not enough', async () => {
    const timers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers });
    handle = booted.handle;
    const { guest, gameId, guestId } = await startedGame(booted.url);

    guest.close();
    await viFlush(() => timers.active() === 1);

    // Another room member knows the (public) playerId but not the secret token.
    const attacker = await open(booted.url);
    const ack = (await attacker.emitWithAck('resume', {
      gameId,
      playerId: guestId,
      resumeToken: 'not-the-real-token',
    })) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected resume to be denied');
    expect(ack.code).toBe('resume_denied');
    // The slot is untouched — the legitimate owner can still resume.
    expect(timers.active()).toBe(1);
  });

  it('accepts position updates again once the socket has resumed', async () => {
    const timers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers });
    handle = booted.handle;
    const { guest, gameId, guestId, guestToken } = await startedGame(booted.url);

    guest.close();
    await viFlush(() => timers.active() === 1);

    const reconnected = await open(booted.url);
    const ack = (await reconnected.emitWithAck('resume', {
      gameId,
      playerId: guestId,
      resumeToken: guestToken,
    })) as LobbyAck;
    if (!ack.ok) throw new Error('resume failed');

    // A tick is only broadcast if the server accepted it against the socket's
    // restored membership. The resumed guest is a hider, so its own game_state
    // carries its position back (a hider sees everyone) — proof the tick landed.
    const echoed = waitUntil<{ gameId: string; positions: Record<string, unknown> }>(
      reconnected,
      'game_state',
      (p) => Boolean(p.positions[guestId]),
    );
    reconnected.emit('position_update', { gameId, playerId: guestId, lat: 52.1, lng: 4.3 });
    const state = await echoed;
    expect(state.positions[guestId]).toMatchObject({ lat: 52.1, lng: 4.3 });
  });

  it('rejects a resume for a player whose slot is already gone', async () => {
    const timers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers });
    handle = booted.handle;
    const { guest, gameId, guestId, guestToken } = await startedGame(booted.url);

    guest.close();
    await viFlush(() => timers.active() === 1);
    // The grace elapses before the client ever reconnects — the slot is released.
    timers.fireAll();

    const reconnected = await open(booted.url);
    const ack = (await reconnected.emitWithAck('resume', {
      gameId,
      playerId: guestId,
      resumeToken: guestToken,
    })) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected resume to fail');
    expect(ack.code).toBe('player_not_found');
  });

  it('rejects a resume into a game that ended during the grace window', async () => {
    const timers = fakeGraceTimers();
    // A controllable survive-the-timer so we can end the match on demand, while
    // the guest is mid-reconnect.
    const gameTimers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers, gameTimers });
    handle = booted.handle;
    const { guest, gameId, guestId, guestToken } = await startedGame(booted.url);

    guest.close();
    await viFlush(() => timers.active() === 1);
    // The match's survive-the-timer elapses (hiders win) while the guest is away.
    gameTimers.fireAll();
    await viFlush(() => handle.lobby.get(gameId)?.status === 'ended');

    const reconnected = await open(booted.url);
    const ack = (await reconnected.emitWithAck('resume', {
      gameId,
      playerId: guestId,
      resumeToken: guestToken,
    })) as LobbyAck;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected resume to fail');
    expect(ack.code).toBe('game_ended');
  });

  it('drops a lobby player immediately — grace only guards an active match', async () => {
    const timers = fakeGraceTimers();
    const booted = await bootServer({ disconnectTimers: timers });
    handle = booted.handle;
    const host = await open(booted.url);
    const guest = await open(booted.url);
    const created = (await host.emitWithAck('create_game', { name: 'Host' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const joined = (await guest.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Guest',
    })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');

    // Still in the lobby (not started): a disconnect drops the player at once and
    // arms no grace timer, mirroring the pre-#24 behaviour.
    const hostSawLeave = waitUntil<{ game: Game }>(
      host,
      'lobby_update',
      (p) => p.game.players.length === 1,
    );
    guest.close();
    await hostSawLeave;
    expect(timers.active()).toBe(0);
    expect(handle.lobby.get(created.game.id)?.players.map((p) => p.name)).toEqual(['Host']);
  });
});

/** Poll `predicate` on the macrotask queue until it holds (bounded), for async
 *  server-side effects a client can't directly await (like the disconnect
 *  handler running after `socket.close()`). */
async function viFlush(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not met in time');
}
