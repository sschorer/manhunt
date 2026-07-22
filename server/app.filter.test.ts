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
 * Per-role state filtering, verified from RAW socket traffic (BACKLOG.md #14).
 *
 * The sibling suites (`app.live.test.ts`, `app.ping.test.ts`) assert on the
 * *decoded* `game_state` payload — they prove the server's read model withholds
 * the hider. This suite closes the issue's second acceptance bullet — "verified
 * from raw socket traffic" — by tapping the hunter's engine.io transport and
 * asserting the hider's coordinates never appear in the bytes delivered to the
 * hunter outside a reveal. That's a strictly stronger guarantee: it proves the
 * coordinate never crossed the wire, not merely that a parsed object omitted it.
 */

/**
 * A controllable timer backing the ping-reveal scheduler so a test can fire a
 * reveal tick on demand (`fire()`) rather than wait on wall-clock time. Mirrors
 * the fake used in `app.ping.test.ts`.
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

async function bootServer(timers: PingTimerApi): Promise<{ handle: ServerHandle; url: string }> {
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

/**
 * Capture the raw engine.io message frames a socket receives. `packet` fires
 * once per decoded transport packet; we keep the `message` frames — the exact
 * socket.io-encoded strings (e.g. `42["game_state",{…}]`) that carried each
 * server emit over the wire — and drop transport noise (ping/pong, open).
 */
function captureFrames(socket: Socket): string[] {
  const frames: string[] = [];
  socket.io.engine.on('packet', (packet: { type: string; data?: unknown }) => {
    if (packet.type === 'message' && packet.data != null) {
      frames.push(String(packet.data));
    }
  });
  return frames;
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

describe('per-role filtering, from raw socket traffic', () => {
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

  it('never puts hider coordinates on the wire to a hunter outside a reveal', async () => {
    const timers = fakeTimers();
    const booted = await bootServer(timers);
    handle = booted.handle;

    const hunter = await open(booted.url); // room host — a hunter
    const hider = await open(booted.url);
    const { gameId, hiderId } = await startedGame(hunter, hider);

    // Distinctive, high-precision coordinates so a substring search can't collide
    // with player ids, timestamps, or any other number in a frame.
    const LAT = 51.987654;
    const LNG = 4.123456;
    const latStr = String(LAT);
    const lngStr = String(LNG);

    // Tap the raw transport on both sides: the hunter (must never see the coords
    // pre-reveal) and the hider (control — the coords MUST appear, proving they
    // really were serialized and the hunter's absence is filtering, not silence).
    const hunterFrames = captureFrames(hunter);
    const hiderFrames = captureFrames(hider);

    // The hider reports a position. Awaiting the hider's own fan-out guarantees
    // the server wrote the fix and emitted the (filtered) broadcast to everyone.
    const hiderSelf = waitFor<GameStateEvent>(hider, 'game_state');
    hider.emit('position_update', { gameId, playerId: hiderId, lat: LAT, lng: LNG });
    const hiderSaw = await hiderSelf;
    expect(hiderSaw.positions[hiderId]).toMatchObject({ lat: LAT, lng: LNG });

    // Ordered barrier on the hunter's own socket: once this ack round-trips, every
    // frame the server sent the hunter before it has already been delivered and
    // captured — no sleep, no race.
    await hunter.emitWithAck('join', { gameId });

    // Control: the hider's raw traffic carries the coordinates.
    expect(hiderFrames.some((f) => f.includes(latStr) && f.includes(lngStr))).toBe(true);

    // The claim: not a single raw byte of the coordinates reached the hunter.
    for (const frame of hunterFrames) {
      expect(frame).not.toContain(latStr);
      expect(frame).not.toContain(lngStr);
    }

    // Fire a reveal. Now — and only now — the hunter's wire carries the hider's
    // coordinates, in a frame flagged as a reveal. This proves the earlier absence
    // was the per-role filter at work, not the coordinate being universally absent.
    const revealed = waitForMatch<GameStateEvent>(hunter, 'game_state', (s) => s.reveal === true);
    timers.fire();
    const reveal = await revealed;
    expect(reveal.positions[hiderId]).toMatchObject({ lat: LAT, lng: LNG });

    const revealFrames = hunterFrames.filter((f) => f.includes(latStr) && f.includes(lngStr));
    expect(revealFrames.length).toBeGreaterThan(0);
    for (const frame of revealFrames) expect(frame).toContain('"reveal":true');
  });
});
