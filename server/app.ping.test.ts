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
  type PingTimerApi,
} from './live/index.ts';
import { createMemoryLobby } from './lobby/rooms.ts';
import type { GameStateEvent } from './protocol/messages.ts';

/**
 * A controllable timer backing the server's ping-reveal scheduler: instead of a
 * real interval, it records the registered handlers so a test can fire a reveal
 * tick on demand (`fire()`), making the reveal deterministic.
 */
function fakeTimers(): PingTimerApi & { fire: () => void } {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setInterval(handler) {
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearInterval(handle) {
      handlers.delete(handle as number);
    },
    fire() {
      for (const handler of handlers.values()) handler();
    },
  };
}

async function bootServer(
  timers: PingTimerApi,
): Promise<{ handle: ServerHandle; url: string }> {
  const handle = createServer({
    staticDir: path.join(os.tmpdir(), 'nope'),
    liveState: {
      store: createMemoryPositionStore(),
      broadcaster: createLocalBroadcaster(),
      close: () => Promise.resolve(),
    },
    lobby: createMemoryLobby(),
    pingTimers: timers,
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

/** Resolve on the first `event` payload that satisfies `pred`, ignoring the rest. */
function waitForMatch<T = unknown>(
  socket: Socket,
  event: string,
  pred: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T): void => {
      if (!pred(payload)) return;
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

type LobbyAck =
  | { ok: true; game: { id: string; roomCode: string }; playerId: string }
  | { ok: false; error: string; code?: string };

/** Stand up an active game: host (hunter) + guest (hider), both ready, started. */
async function startedGame(
  hunter: Socket,
  hider: Socket,
): Promise<{ gameId: string; hiderId: string }> {
  const created = (await hunter.emitWithAck('create_game', { name: 'Seeker' })) as LobbyAck;
  if (!created.ok) throw new Error('create_game failed');
  const { id: gameId, roomCode } = created.game;
  const joined = (await hider.emitWithAck('join_game', { roomCode, name: 'Runner' })) as LobbyAck;
  if (!joined.ok) throw new Error('join_game failed');
  await hunter.emitWithAck('set_ready', { ready: true });
  await hider.emitWithAck('set_ready', { ready: true });
  const started = (await hunter.emitWithAck('start_game', {})) as LobbyAck;
  if (!started.ok) throw new Error(`start_game failed: ${started.error}`);
  return { gameId, hiderId: joined.playerId };
}

describe('ping-reveal scheduler over the socket', () => {
  let handle: ServerHandle;
  const clients: Socket[] = [];

  async function open(url: string): Promise<Socket> {
    const c = connect(url);
    clients.push(c);
    await waitFor(c, 'connect');
    return c;
  }

  afterEach(async () => {
    handle.pingScheduler.stopAll();
    for (const c of clients.splice(0)) c.close();
    handle.io.close();
    handle.httpServer.close();
    await once(handle.httpServer, 'close');
    await handle.liveState.close();
  });

  it('reveals hider positions to a hunter on a reveal tick, not before', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers);
    handle = booted.handle;

    const hunter = await open(booted.url); // room host — a hunter
    const hider = await open(booted.url);
    const { gameId, hiderId } = await startedGame(hunter, hider);
    expect(handle.pingScheduler.isRunning(gameId)).toBe(true);

    // Record every state the hunter receives so we can prove no un-revealed
    // broadcast ever leaks the hider.
    const hunterStates: GameStateEvent[] = [];
    hunter.on('game_state', (s: GameStateEvent) => hunterStates.push(s));

    // The hider reports a position. Awaiting the hider's own fan-out guarantees
    // the fix is stored (the write precedes the broadcast) before we reveal.
    const hiderSelf = waitFor<GameStateEvent>(hider, 'game_state');
    hider.emit('position_update', { gameId, playerId: hiderId, lat: 52.1, lng: 4.3 });
    const hiderSaw = await hiderSelf;
    expect(hiderSaw.positions[hiderId]).toMatchObject({ lat: 52.1, lng: 4.3 });

    // Steady state: nothing the hunter has seen so far carries the hider.
    for (const s of hunterStates) expect(s.positions[hiderId]).toBeUndefined();

    // Fire a reveal tick. The hunter now receives the hider's position, flagged
    // as a reveal — the one broadcast where the per-role filter is lifted.
    const revealed = waitForMatch<GameStateEvent>(hunter, 'game_state', (s) => s.reveal === true);
    timers.fire();
    const reveal = await revealed;
    expect(reveal.gameId).toBe(gameId);
    expect(reveal.reveal).toBe(true);
    expect(reveal.positions[hiderId]).toMatchObject({ lat: 52.1, lng: 4.3 });

    // And no un-revealed broadcast ever carried the hider.
    for (const s of hunterStates) {
      if (!s.reveal) expect(s.positions[hiderId]).toBeUndefined();
    }
  });

  it('does not broadcast an empty reveal before anyone has reported a position', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers);
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId } = await startedGame(hunter, hider);

    let got = false;
    hunter.on('game_state', () => {
      got = true;
    });
    hider.on('game_state', () => {
      got = true;
    });

    // No positions reported yet → the reveal has nothing to disclose and is skipped.
    timers.fire();
    // Ordered barrier: once this round-trips, the server has handled the (skipped)
    // reveal, so a stray broadcast would already have arrived.
    await hunter.emitWithAck('join', { gameId });
    expect(got).toBe(false);
  });

  it('stops revealing once the game is torn down', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers);
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId } = await startedGame(hunter, hider);
    expect(handle.pingScheduler.isRunning(gameId)).toBe(true);

    // Both players leave → the room is deleted → the reveal timer is cleared.
    await hider.emitWithAck('leave_game', {});
    await hunter.emitWithAck('leave_game', {});
    expect(handle.pingScheduler.isRunning(gameId)).toBe(false);
  });
});
