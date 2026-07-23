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
import type { PushPayload, PushSender, PushSubscription } from './push/index.ts';

/**
 * A controllable ping timer (see app.ping.test.ts): records the reveal handler so
 * a test can fire a reveal tick on demand rather than waiting on wall-clock time.
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

interface Sent {
  subscription: PushSubscription;
  payload: PushPayload;
}

/** A fake push sender that records every delivery for assertions. */
function recordingSender(): PushSender & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send(subscription, payload) {
      sent.push({ subscription, payload });
      return Promise.resolve({ ok: true });
    },
  };
}

/** A public https endpoint URL for a named subscription (the validator requires one). */
function ep(name: string): string {
  return `https://push.example.com/${name}`;
}

function subscription(name: string): PushSubscription {
  return { endpoint: ep(name), keys: { p256dh: 'p', auth: 'a' } };
}

async function bootServer(
  sender: PushSender,
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
    // Force push on with a fake sender, regardless of the ambient env.
    vapidConfig: { publicKey: 'test-pub', privateKey: 'test-priv', subject: 'mailto:t@e.com' },
    pushSender: sender,
    pingTimers: timers,
    // A generous catch radius so a claim from the same coordinates always lands.
    catchRadiusM: 1000,
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

type LobbyAck =
  | { ok: true; game: { id: string; roomCode: string }; playerId: string }
  | { ok: false; error: string; code?: string };

/** Stand up an active game: host (hunter) + guest (hider), both ready, started. */
async function startedGame(
  hunter: Socket,
  hider: Socket,
): Promise<{ gameId: string; hunterId: string; hiderId: string }> {
  const created = (await hunter.emitWithAck('create_game', { name: 'Seeker' })) as LobbyAck;
  if (!created.ok) throw new Error('create_game failed');
  const { id: gameId, roomCode } = created.game;
  const joined = (await hider.emitWithAck('join_game', { roomCode, name: 'Runner' })) as LobbyAck;
  if (!joined.ok) throw new Error('join_game failed');
  await hunter.emitWithAck('set_ready', { ready: true });
  await hider.emitWithAck('set_ready', { ready: true });
  const started = (await hunter.emitWithAck('start_game', {})) as LobbyAck;
  if (!started.ok) throw new Error(`start_game failed: ${started.error}`);
  return { gameId, hunterId: created.playerId, hiderId: joined.playerId };
}

describe('Web Push over the socket', () => {
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
    handle.outcomeTracker.stopAll();
    for (const c of clients.splice(0)) c.close();
    handle.io.close();
    handle.httpServer.close();
    await once(handle.httpServer, 'close');
    await handle.liveState.close();
  });

  it('advertises the VAPID public key over HTTP', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const res = await fetch(`${booted.url}/api/push/vapid-public-key`);
    expect(await res.json()).toEqual({ key: 'test-pub' });
  });

  it('withholds the key (null) when push is disabled', async () => {
    // A server with push forced off (vapidConfig: null).
    handle = createServer({
      staticDir: path.join(os.tmpdir(), 'nope'),
      liveState: {
        store: createMemoryPositionStore(),
        broadcaster: createLocalBroadcaster(),
        close: () => Promise.resolve(),
      },
      lobby: createMemoryLobby(),
      vapidConfig: null,
    });
    handle.httpServer.listen(0);
    await once(handle.httpServer, 'listening');
    const { port } = handle.httpServer.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/push/vapid-public-key`);
    expect(await res.json()).toEqual({ key: null });
  });

  it('rejects a subscribe from a socket that is not in a game', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const lonely = await open(booted.url);
    const ack = (await lonely.emitWithAck('push_subscribe', subscription('e1'))) as {
      ok: boolean;
      code?: string;
    };
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('player_not_found');
  });

  it('rejects a malformed subscription', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    await startedGame(hunter, hider);

    const ack = (await hider.emitWithAck('push_subscribe', { endpoint: '' })) as {
      ok: boolean;
      code?: string;
    };
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('endpoint_required');
  });

  it('pushes the caught event to the caught hider', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId, hunterId, hiderId } = await startedGame(hunter, hider);

    // The hider opts in to push, then both report the same position so the catch
    // is within range.
    await hider.emitWithAck('push_subscribe', subscription('hider-ep'));
    const hunterSelf = waitFor(hunter, 'game_state');
    hunter.emit('position_update', { gameId, playerId: hunterId, lat: 52.1, lng: 4.3 });
    await hunterSelf;
    const hiderSelf = waitFor(hider, 'game_state');
    hider.emit('position_update', { gameId, playerId: hiderId, lat: 52.1, lng: 4.3 });
    await hiderSelf;

    const confirmed = waitFor(hider, 'catch_confirmed');
    const ack = (await hunter.emitWithAck('claim_catch', {
      gameId,
      hunterId,
      targetId: hiderId,
    })) as { ok: boolean; error?: string };
    expect(ack.ok).toBe(true);
    await confirmed;

    // The catch flips the last hider, ending the game; the caught push is what we
    // assert here (the game-over push also fans out — see below).
    const caught = sender.sent.find((s) => s.payload.data.kind === 'caught');
    expect(caught).toBeDefined();
    expect(caught?.subscription.endpoint).toBe(ep('hider-ep'));
    expect(caught?.payload.data.gameId).toBe(gameId);
  });

  it('pushes the reveal event to hunters only', async () => {
    const sender = recordingSender();
    const timers = fakeTimers();
    const booted = await bootServer(sender, timers);
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId, hunterId, hiderId } = await startedGame(hunter, hider);

    // Both players opt in.
    await hunter.emitWithAck('push_subscribe', subscription('hunter-ep'));
    await hider.emitWithAck('push_subscribe', subscription('hider-ep'));

    // A position must exist for the reveal to have anything to disclose.
    const hiderSelf = waitFor(hider, 'game_state');
    hider.emit('position_update', { gameId, playerId: hiderId, lat: 52.1, lng: 4.3 });
    await hiderSelf;

    const revealed = waitFor(hunter, 'game_state');
    timers.fire();
    await revealed;
    // Barrier: round-trip an ack so the async reveal push has been handled.
    await hunter.emitWithAck('join', { gameId });

    const reveals = sender.sent.filter((s) => s.payload.data.kind === 'reveal');
    expect(reveals).toHaveLength(1);
    expect(reveals[0]?.subscription.endpoint).toBe(ep('hunter-ep'));
    // The hider must never get a reveal push.
    expect(sender.sent.some((s) => s.subscription.endpoint === ep('hider-ep'))).toBe(false);
    // Reference the ids so the fixture reads clearly.
    expect(hunterId).not.toBe(hiderId);
  });

  it('pushes the game-over result to everyone subscribed', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId, hunterId, hiderId } = await startedGame(hunter, hider);

    await hunter.emitWithAck('push_subscribe', subscription('hunter-ep'));
    await hider.emitWithAck('push_subscribe', subscription('hider-ep'));

    const hunterSelf = waitFor(hunter, 'game_state');
    hunter.emit('position_update', { gameId, playerId: hunterId, lat: 52.1, lng: 4.3 });
    await hunterSelf;
    const hiderSelf = waitFor(hider, 'game_state');
    hider.emit('position_update', { gameId, playerId: hiderId, lat: 52.1, lng: 4.3 });
    await hiderSelf;

    const over = waitFor(hunter, 'game_over');
    // Catch the last hider → hunters win → game over.
    await hunter.emitWithAck('claim_catch', { gameId, hunterId, targetId: hiderId });
    await over;

    const gameOver = sender.sent.filter((s) => s.payload.data.kind === 'game_over');
    const endpoints = gameOver.map((s) => s.subscription.endpoint).sort();
    expect(endpoints).toEqual([ep('hider-ep'), ep('hunter-ep')]);
    expect(gameOver[0]?.payload.data.winner).toBe('hunters');
  });

  it('drops a subscription when the player leaves', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId, hiderId } = await startedGame(hunter, hider);

    await hider.emitWithAck('push_subscribe', subscription('hider-ep'));
    expect(handle.subscriptions.get(gameId, hiderId)).toBeDefined();

    await hider.emitWithAck('leave_game', {});
    expect(handle.subscriptions.get(gameId, hiderId)).toBeUndefined();
  });

  it('drops a subscription on push_unsubscribe while the player stays in the game', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    const { gameId, hiderId } = await startedGame(hunter, hider);

    await hider.emitWithAck('push_subscribe', subscription('hider-ep'));
    expect(handle.subscriptions.get(gameId, hiderId)).toBeDefined();

    const ack = (await hider.emitWithAck('push_unsubscribe', {})) as { ok: boolean };
    expect(ack.ok).toBe(true);
    expect(handle.subscriptions.get(gameId, hiderId)).toBeUndefined();
    // The player is still a member — the roster is untouched.
    expect(handle.lobby.get(gameId)?.players.some((p) => p.id === hiderId)).toBe(true);
  });

  it('rejects a subscription whose endpoint is not a public https URL', async () => {
    const sender = recordingSender();
    const booted = await bootServer(sender, fakeTimers());
    handle = booted.handle;

    const hunter = await open(booted.url);
    const hider = await open(booted.url);
    await startedGame(hunter, hider);

    const ack = (await hider.emitWithAck('push_subscribe', {
      endpoint: 'http://127.0.0.1/steal',
      keys: { p256dh: 'p', auth: 'a' },
    })) as { ok: boolean; code?: string };
    expect(ack.ok).toBe(false);
    expect(ack.code).toBe('invalid_endpoint');
  });
});
