import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createServer, type ServerHandle } from './app.ts';
import { createLocalBroadcaster, createMemoryPositionStore } from './live/index.ts';
import { createMemoryLobby, type Game } from './lobby/rooms.ts';
import type { CatchConfirmedEvent, GameStateEvent } from './protocol/messages.ts';

type CatchAck =
  | { ok: true; catch: CatchConfirmedEvent }
  | { ok: false; error: string; code?: string };

type LobbyAck =
  | { ok: true; game: Game; playerId: string }
  | { ok: false; error: string; code?: string };

/** Amsterdam's Dam square — the anchor the players are positioned around. */
const BASE = { lat: 52.3731, lng: 4.8922 };
/** A point roughly `meters` due north of `BASE` (~111.32 km per degree of latitude). */
function northOf(meters: number): { lat: number; lng: number } {
  return { lat: BASE.lat + meters / 111_320, lng: BASE.lng };
}

/**
 * Boot the real server on an ephemeral port with in-memory hot state and a real
 * lobby, with an explicit catch radius so the distance check is deterministic.
 */
async function bootServer(catchRadiusM = 15): Promise<{ handle: ServerHandle; url: string }> {
  const handle = createServer({
    staticDir: path.join(os.tmpdir(), 'nope'),
    liveState: {
      store: createMemoryPositionStore(),
      broadcaster: createLocalBroadcaster(),
      close: () => Promise.resolve(),
    },
    lobby: createMemoryLobby(),
    catchRadiusM,
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

describe('claim_catch rules engine (catch-radius + role switch) over the socket', () => {
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

  /**
   * Stand up an active game: a host (hunter) and a guest (hider), both readied,
   * the match started. Returns the sockets and the players' authoritative ids.
   */
  async function activeGame(url: string): Promise<{
    hunter: Socket;
    hider: Socket;
    gameId: string;
    hunterId: string;
    hiderId: string;
  }> {
    const hunter = await open(url);
    const hider = await open(url);

    const created = (await hunter.emitWithAck('create_game', { name: 'Hunter' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');
    const joined = (await hider.emitWithAck('join_game', {
      roomCode: created.game.roomCode,
      name: 'Hider',
    })) as LobbyAck;
    if (!joined.ok) throw new Error('join failed');

    await hunter.emitWithAck('set_ready', { ready: true });
    await hider.emitWithAck('set_ready', { ready: true });
    const started = (await hunter.emitWithAck('start_game', {})) as LobbyAck;
    if (!started.ok) throw new Error('start failed');

    return {
      hunter,
      hider,
      gameId: created.game.id,
      hunterId: created.playerId,
      hiderId: joined.playerId,
    };
  }

  /** Report both players' positions and wait until the server has stored both. */
  async function place(
    game: { hunter: Socket; hider: Socket; gameId: string; hunterId: string; hiderId: string },
    hunterPos: { lat: number; lng: number },
    hiderPos: { lat: number; lng: number },
  ): Promise<void> {
    // The hider (who sees the full snapshot) tells us when both fixes have landed.
    const bothStored = waitUntil<GameStateEvent>(
      game.hider,
      'game_state',
      (p) => Boolean(p.positions[game.hunterId]) && Boolean(p.positions[game.hiderId]),
    );
    game.hunter.emit('position_update', { gameId: game.gameId, playerId: game.hunterId, ...hunterPos });
    game.hider.emit('position_update', { gameId: game.gameId, playerId: game.hiderId, ...hiderPos });
    await bothStored;
  }

  it('confirms an in-range catch, broadcasts it, and flips the hider to a hunter', async () => {
    const booted = await bootServer(15);
    handle = booted.handle;
    const game = await activeGame(booted.url);
    await place(game, BASE, northOf(5)); // ~5 m apart, within the 15 m radius

    const hiderSawCatch = waitFor<CatchConfirmedEvent>(game.hider, 'catch_confirmed');
    const roleFlipped = waitUntil<{ game: Game }>(
      game.hider,
      'lobby_update',
      (p) => p.game.players.find((x) => x.id === game.hiderId)?.role === 'hunter',
    );

    const ack = (await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: game.hiderId,
    })) as CatchAck;

    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected the claim to succeed');
    expect(ack.catch).toMatchObject({
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: game.hiderId,
    });

    const event = await hiderSawCatch;
    expect(event).toMatchObject({ hunterId: game.hunterId, targetId: game.hiderId });

    // The caught hider is now a hunter, both in the broadcast roster and server-side.
    const updated = await roleFlipped;
    expect(updated.game.players.find((p) => p.id === game.hiderId)?.role).toBe('hunter');
    expect(handle.lobby.get(game.gameId)?.players.find((p) => p.id === game.hiderId)?.role).toBe(
      'hunter',
    );
  });

  it('rejects an out-of-range claim with no catch and no role change', async () => {
    const booted = await bootServer(15);
    handle = booted.handle;
    const game = await activeGame(booted.url);
    await place(game, BASE, northOf(500)); // ~500 m apart, well outside the radius

    let broadcast = false;
    game.hider.on('catch_confirmed', () => {
      broadcast = true;
    });

    const ack = (await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: game.hiderId,
    })) as CatchAck;

    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected the out-of-range claim to fail');
    expect(ack.code).toBe('out_of_range');

    await new Promise((r) => setTimeout(r, 50));
    expect(broadcast).toBe(false);
    // The hider is still a hider — no state changed.
    expect(handle.lobby.get(game.gameId)?.players.find((p) => p.id === game.hiderId)?.role).toBe(
      'hider',
    );
  });

  it('rejects a claim before any positions are reported', async () => {
    const booted = await bootServer(15);
    handle = booted.handle;
    const game = await activeGame(booted.url);

    const ack = (await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: game.hiderId,
    })) as CatchAck;

    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected a no_position rejection');
    expect(ack.code).toBe('no_position');
  });

  it('rejects a claim from a socket with no lobby membership', async () => {
    const booted = await bootServer(15);
    handle = booted.handle;
    const game = await activeGame(booted.url);
    await place(game, BASE, northOf(5));

    // A stranger who only `join`ed the room (no lobby identity) cannot claim.
    const stranger = await open(booted.url);
    await stranger.emitWithAck('join', { gameId: game.gameId });
    const ack = (await stranger.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: game.hiderId,
    })) as CatchAck;

    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected the stranger claim to fail');
    expect(ack.code).toBe('not_hunter');
  });

  it('rejects a hider trying to claim a catch', async () => {
    const booted = await bootServer(15);
    handle = booted.handle;
    const game = await activeGame(booted.url);
    await place(game, BASE, northOf(5));

    // The hider claims to catch the hunter: the claimant isn't a hunter.
    const ack = (await game.hider.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hiderId,
      targetId: game.hunterId,
    })) as CatchAck;

    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error('expected the hider claim to fail');
    expect(ack.code).toBe('not_hunter');
  });

  it('still rejects a malformed claim at the validation edge', async () => {
    const booted = await bootServer(15);
    handle = booted.handle;
    const game = await activeGame(booted.url);

    const missingTarget = (await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
    })) as CatchAck;
    expect(missingTarget.ok).toBe(false);
    if (missingTarget.ok) throw new Error('expected failure');
    expect(missingTarget.code).toBe('target_id_required');

    const selfCatch = (await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: game.hunterId,
    })) as CatchAck;
    expect(selfCatch.ok).toBe(false);
    if (selfCatch.ok) throw new Error('expected self-catch to fail');
    expect(selfCatch.code).toBe('self_catch');
  });
});
