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
  type GameTimerApi,
} from './live/index.ts';
import { createMemoryLobby, type Game } from './lobby/rooms.ts';
import type { CatchConfirmedEvent, GameOverEvent, GameStateEvent } from './protocol/messages.ts';

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
 * A controllable one-shot timer backing the server's survive-the-timer countdown:
 * instead of a real timeout it records the registered handlers so a test can fire
 * the countdown on demand (`fire()`), making the "hiders survive" win deterministic.
 */
function fakeTimers(): GameTimerApi & { fire: () => void } {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeout(handler) {
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearTimeout(handle) {
      handlers.delete(handle as number);
    },
    fire() {
      for (const handler of [...handlers.values()]) handler();
    },
  };
}

/**
 * Boot the real server on an ephemeral port with in-memory hot state, a real
 * lobby, a deterministic catch radius, and a controllable survive-the-timer clock.
 */
async function bootServer(
  gameTimers: GameTimerApi,
  catchRadiusM = 15,
): Promise<{ handle: ServerHandle; url: string }> {
  const handle = createServer({
    staticDir: path.join(os.tmpdir(), 'nope'),
    liveState: {
      store: createMemoryPositionStore(),
      broadcaster: createLocalBroadcaster(),
      close: () => Promise.resolve(),
    },
    lobby: createMemoryLobby(),
    catchRadiusM,
    gameTimers,
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

describe('win conditions + end screen data over the socket', () => {
  let handle: ServerHandle;
  const clients: Socket[] = [];

  async function open(url: string): Promise<Socket> {
    const c = connect(url);
    clients.push(c);
    await waitFor(c, 'connect');
    return c;
  }

  afterEach(async () => {
    handle.outcomeTracker.stopAll();
    handle.pingScheduler.stopAll();
    for (const c of clients.splice(0)) c.close();
    handle.io.close();
    handle.httpServer.close();
    await once(handle.httpServer, 'close');
    await handle.liveState.close();
  });

  /**
   * Stand up an active game: a host (hunter) and `hiderCount` guests (hiders), all
   * readied, the match started. Returns the sockets and authoritative ids.
   */
  async function activeGame(
    url: string,
    hiderCount = 1,
  ): Promise<{
    hunter: Socket;
    hunterId: string;
    gameId: string;
    hiders: { socket: Socket; id: string; name: string }[];
  }> {
    const hunter = await open(url);
    const created = (await hunter.emitWithAck('create_game', { name: 'Hunter' })) as LobbyAck;
    if (!created.ok) throw new Error('create failed');

    const hiders: { socket: Socket; id: string; name: string }[] = [];
    for (let i = 0; i < hiderCount; i += 1) {
      const socket = await open(url);
      const name = `Hider${i + 1}`;
      const joined = (await socket.emitWithAck('join_game', {
        roomCode: created.game.roomCode,
        name,
      })) as LobbyAck;
      if (!joined.ok) throw new Error('join failed');
      hiders.push({ socket, id: joined.playerId, name });
    }

    await hunter.emitWithAck('set_ready', { ready: true });
    for (const h of hiders) await h.socket.emitWithAck('set_ready', { ready: true });
    const started = (await hunter.emitWithAck('start_game', {})) as LobbyAck;
    if (!started.ok) throw new Error(`start failed: ${started.error}`);

    return { hunter, hunterId: created.playerId, gameId: created.game.id, hiders };
  }

  /**
   * Report a player's own position from that player's socket and wait until the
   * server has stored it. A `position_update` is dropped unless the emitting
   * socket owns the claimed id, so `owner` is both the emitter and (since every
   * player sees their own fix) the socket we await the fan-out on.
   */
  async function place(
    owner: Socket,
    gameId: string,
    playerId: string,
    pos: { lat: number; lng: number },
  ): Promise<void> {
    const stored = waitUntil<GameStateEvent>(
      owner,
      'game_state',
      (p) => Boolean(p.positions[playerId]),
    );
    owner.emit('position_update', { gameId, playerId, ...pos });
    await stored;
  }

  it('ends the game when the last hider is caught: hunters win, with a summary', async () => {
    const booted = await bootServer(fakeTimers(), 15);
    handle = booted.handle;
    const game = await activeGame(booted.url, 1);
    const hider = game.hiders[0]!;

    // Both stand within the catch radius so the claim will succeed.
    await place(game.hunter, game.gameId, game.hunterId, BASE);
    await place(hider.socket, game.gameId, hider.id, northOf(5));

    const gameOver = waitFor<GameOverEvent>(hider.socket, 'game_over');
    const ack = (await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: hider.id,
    })) as CatchAck;
    expect(ack.ok).toBe(true);

    const event = await gameOver;
    expect(event.gameId).toBe(game.gameId);
    expect(event.summary.winner).toBe('hunters');
    expect(event.summary.reason).toBe('all_caught');
    // The summary lists the catch and the hider's survival time.
    expect(event.summary.catches).toHaveLength(1);
    expect(event.summary.catches[0]).toMatchObject({ hunterId: game.hunterId, targetId: hider.id });
    expect(event.summary.hiders).toHaveLength(1);
    expect(event.summary.hiders[0]).toMatchObject({ playerId: hider.id, name: hider.name, caught: true });
    expect(event.summary.hiders[0]?.survivalMs).toBeGreaterThanOrEqual(0);
    expect(event.summary.hiders[0]?.caughtAt).toBeTruthy();

    // The room is now 'ended' and its timers are cleared.
    expect(handle.lobby.get(game.gameId)?.status).toBe('ended');
    expect(handle.outcomeTracker.isTracking(game.gameId)).toBe(false);
    expect(handle.pingScheduler.isRunning(game.gameId)).toBe(false);
  });

  it('ends the game when the timer runs out with a hider still free: hiders win', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers, 15);
    handle = booted.handle;
    const game = await activeGame(booted.url, 1);
    const hider = game.hiders[0]!;

    const gameOver = waitFor<GameOverEvent>(game.hunter, 'game_over');
    // The survive-the-timer countdown elapses — the hider lasted the match.
    timers.fire();

    const event = await gameOver;
    expect(event.summary.winner).toBe('hiders');
    expect(event.summary.reason).toBe('timer');
    expect(event.summary.hiders[0]).toMatchObject({ playerId: hider.id, caught: false });
    // A survivor has no capture time.
    expect(event.summary.hiders[0]?.caughtAt).toBeUndefined();
    expect(handle.lobby.get(game.gameId)?.status).toBe('ended');
  });

  it('with two hiders, catching one leaves the game running until the timer', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers, 15);
    handle = booted.handle;
    const game = await activeGame(booted.url, 2);
    const [first, second] = game.hiders as [
      { socket: Socket; id: string; name: string },
      { socket: Socket; id: string; name: string },
    ];

    // Catch only the first hider — the second is still free, so no game over yet.
    await place(game.hunter, game.gameId, game.hunterId, BASE);
    await place(first.socket, game.gameId, first.id, northOf(5));

    let endedEarly = false;
    game.hunter.on('game_over', () => {
      endedEarly = true;
    });
    const caught = waitFor<CatchConfirmedEvent>(second.socket, 'catch_confirmed');
    await game.hunter.emitWithAck('claim_catch', {
      gameId: game.gameId,
      hunterId: game.hunterId,
      targetId: first.id,
    });
    await caught;
    // Ordered barrier: once this round-trips the (non-)end has been handled.
    await game.hunter.emitWithAck('join', { gameId: game.gameId });
    expect(endedEarly).toBe(false);
    expect(handle.lobby.get(game.gameId)?.status).toBe('active');

    // Now the timer fires with the second hider still free — hiders win, and the
    // summary distinguishes the caught hider from the survivor.
    const gameOver = waitFor<GameOverEvent>(game.hunter, 'game_over');
    timers.fire();
    const event = await gameOver;
    expect(event.summary.winner).toBe('hiders');
    expect(event.summary.reason).toBe('timer');
    const summaryFirst = event.summary.hiders.find((h) => h.playerId === first.id);
    const summarySecond = event.summary.hiders.find((h) => h.playerId === second.id);
    expect(summaryFirst).toMatchObject({ caught: true });
    expect(summarySecond).toMatchObject({ caught: false });
    expect(event.summary.catches).toHaveLength(1);
  });

  it('drops the survive timer when the room empties before it fires', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers, 15);
    handle = booted.handle;
    const game = await activeGame(booted.url, 1);
    const hider = game.hiders[0]!;

    expect(handle.outcomeTracker.isTracking(game.gameId)).toBe(true);
    await hider.socket.emitWithAck('leave_game', {});
    await game.hunter.emitWithAck('leave_game', {});
    expect(handle.outcomeTracker.isTracking(game.gameId)).toBe(false);

    // Firing now must not throw or resurrect a game_over for the dead game.
    expect(() => timers.fire()).not.toThrow();
  });
});
