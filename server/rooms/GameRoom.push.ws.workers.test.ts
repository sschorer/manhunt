import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameSnapshot } from '../game/game.ts';
import { createTestSubscription, type TestSubscription } from '../push/testing.ts';
import {
  connect,
  createGame,
  joinGame,
  lobbyWhere,
  readyCy,
  stateWhere,
  stubFor,
  type Received,
} from './testing.workers.ts';

/** The anchor the players are placed around. */
const BASE = { lat: 0, lng: 0 };
/** ~5.6 m north of the anchor — inside the Catch radius. */
const NEAR = { lat: 0.00005, lng: 0 };

interface Delivered {
  url: string;
  init: RequestInit;
}

/**
 * A push service in place of the real one: the Durable Object shares this
 * isolate's `fetch`, so stubbing it here is where its pushes arrive.
 */
function pushService(respond: () => Promise<Response>): { delivered: Delivered[] } {
  const delivered: Delivered[] = [];
  vi.stubGlobal('fetch', (url: string | URL | Request, init: RequestInit = {}) => {
    delivered.push({ url: String(url), init });
    return respond();
  });
  return { delivered };
}

const accepted = () => Promise.resolve(new Response(null, { status: 201 }));

/** The Game's persisted snapshot, read straight out of its SQLite row. */
async function storedSnapshot(gameId: string): Promise<GameSnapshot> {
  const row = await runInDurableObject(stubFor(gameId), (_room, state) =>
    state.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM game WHERE id = 1').toArray()[0],
  );
  return JSON.parse(row!.snapshot) as GameSnapshot;
}

/**
 * An active Game with the Host (a Hunter) next to Bo (a Hider), and Cy as a
 * second Hider so catching Bo doesn't end it.
 */
async function placedGame() {
  const host = await createGame();
  const bo = await joinGame(host.game.roomCode);
  const hostSocket = await connect(host.game.id, host.token);
  const boSocket = await connect(host.game.id, bo.token);
  await hostSocket.next(lobbyWhere());
  await boSocket.next(lobbyWhere());
  await hostSocket.request('set_ready', { ready: true });
  await boSocket.request('set_ready', { ready: true });
  const { cySocket } = await readyCy(host.game);
  expect(await hostSocket.request('start_game', {})).toMatchObject({ ok: true });

  hostSocket.send('position_update', { gameId: host.game.id, playerId: host.playerId, ...BASE });
  boSocket.send('position_update', { gameId: host.game.id, playerId: bo.playerId, ...NEAR });
  // Bo is the Hider, so Bo's view is the one that holds both fixes.
  await boSocket.next(stateWhere((event) => host.playerId in event.positions && bo.playerId in event.positions));

  const catchBo = () =>
    hostSocket.request('claim_catch', { gameId: host.game.id, hunterId: host.playerId, targetId: bo.playerId });
  const done = () => {
    for (const socket of [hostSocket, boSocket, cySocket]) socket.ws.close(1000, 'done');
  };
  return { host, bo, hostSocket, boSocket, cySocket, catchBo, done };
}

let subscription: TestSubscription;

beforeEach(async () => {
  subscription = await createTestSubscription();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GameRoom Web Push', () => {
  it('delivers a caught notification to the Hider who opted in', async () => {
    const service = pushService(accepted);
    const game = await placedGame();
    expect(await game.boSocket.request('push_subscribe', subscription.subscription)).toEqual({ ok: true });

    expect(await game.catchBo()).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(service.delivered).toHaveLength(1));
    const [delivered] = service.delivered;
    expect(delivered?.url).toBe(subscription.subscription.endpoint);
    expect(new Headers(delivered?.init.headers).get('urgency')).toBe('high');
    expect(await subscription.decrypt(delivered?.init.body as ArrayBuffer)).toMatchObject({
      title: "You've been caught!",
      data: { gameId: game.host.game.id, kind: 'caught' },
    });
    game.done();
  });

  it('pushes nothing for a player who never opted in', async () => {
    const service = pushService(accepted);
    const game = await placedGame();

    expect(await game.catchBo()).toMatchObject({ ok: true });

    // The Catch is through, so anything the Game wanted to push would be out by now.
    await game.hostSocket.next((frame: Received) => frame.t === 'catch_confirmed');
    expect(service.delivered).toEqual([]);
    game.done();
  });

  it('keeps playing while a push service hangs', async () => {
    let release: (() => void) | undefined;
    const hanging = new Promise<Response>((resolve) => {
      release = () => resolve(new Response(null, { status: 201 }));
    });
    const service = pushService(() => hanging);
    const game = await placedGame();
    await game.boSocket.request('push_subscribe', subscription.subscription);

    // The Catch is answered and broadcast with the push still in flight, and the
    // Game takes the next request as well: it never waits for a push service.
    expect(await game.catchBo()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(service.delivered).toHaveLength(1));
    await game.boSocket.next((frame: Received) => frame.t === 'catch_confirmed');
    expect(await game.hostSocket.request('set_ready', { ready: false })).toMatchObject({
      ok: false,
      code: 'already_started',
    });

    release?.();
    game.done();
  });

  it('drops a subscription the push service no longer has', async () => {
    pushService(() => Promise.resolve(new Response(null, { status: 410 })));
    const game = await placedGame();
    await game.boSocket.request('push_subscribe', subscription.subscription);
    expect((await storedSnapshot(game.host.game.id)).seats.find((seat) => seat.playerId === game.bo.playerId)?.push)
      .toBeDefined();

    expect(await game.catchBo()).toMatchObject({ ok: true });

    await vi.waitFor(async () => {
      const seats = (await storedSnapshot(game.host.game.id)).seats;
      expect(seats.find((seat) => seat.playerId === game.bo.playerId)?.push).toBeUndefined();
    });
    game.done();
  });

  it('keeps a subscription a push service only failed on', async () => {
    pushService(() => Promise.resolve(new Response(null, { status: 503 })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const game = await placedGame();
    await game.boSocket.request('push_subscribe', subscription.subscription);

    expect(await game.catchBo()).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    const seats = (await storedSnapshot(game.host.game.id)).seats;
    expect(seats.find((seat) => seat.playerId === game.bo.playerId)?.push).toBeDefined();
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(subscription.subscription.endpoint);
    game.done();
  });

  it('pushes the end of the Game to everyone who opted in', async () => {
    const service = pushService(accepted);
    const game = await placedGame();
    const hostSubscription = await createTestSubscription('https://web.push.apple.com/host');
    await game.boSocket.request('push_subscribe', subscription.subscription);
    await game.hostSocket.request('push_subscribe', hostSubscription.subscription);

    // Bo is caught and Cy leaves: with no Hider left in play, the Hunters win.
    expect(await game.catchBo()).toMatchObject({ ok: true });
    expect(await game.cySocket.request('leave_game', undefined)).toMatchObject({ ok: true });
    await game.hostSocket.next((frame: Received) => frame.t === 'game_over');

    // Bo's caught push, then the end of the Game to both of them.
    await vi.waitFor(() => expect(service.delivered).toHaveLength(3));
    const toHost = service.delivered.filter((delivered) => delivered.url === hostSubscription.subscription.endpoint);
    expect(toHost).toHaveLength(1);
    expect(await hostSubscription.decrypt(toHost[0]!.init.body as ArrayBuffer)).toMatchObject({
      title: 'Game over',
      data: { gameId: game.host.game.id, kind: 'game_over', winner: 'hunters' },
    });
    game.done();
  });
});
