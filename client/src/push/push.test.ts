import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameConnection } from '../transport/gameConnection.ts';
import {
  connectionTransport,
  disablePush,
  enablePush,
  fetchVapidPublicKey,
  isPushSupported,
  socketTransport,
  urlBase64ToUint8Array,
  type PushTransport,
} from './push.ts';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url string, restoring padding and the url alphabet', () => {
    // "hi" → base64 "aGk=" → base64url "aGk" (no padding).
    expect([...urlBase64ToUint8Array('aGk')]).toEqual([104, 105]);
  });

  it('maps the url-safe characters (- _) back before decoding', () => {
    // 0xfb 0xff → base64 "+/8=" → base64url "-_8".
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([0xfb, 0xff]);
  });
});

describe('fetchVapidPublicKey', () => {
  it('returns the key the server advertises', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: 'server-key' }),
    });
    await expect(fetchVapidPublicKey(fetchImpl as unknown as typeof fetch)).resolves.toBe('server-key');
    expect(fetchImpl).toHaveBeenCalledWith('/api/push/vapid-public-key');
  });

  it('returns null when the server advertises no key (push disabled)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: null }),
    });
    await expect(fetchVapidPublicKey(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    await expect(fetchVapidPublicKey(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('returns null when the request throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(fetchVapidPublicKey(fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe('isPushSupported', () => {
  const original = {
    serviceWorker: (navigator as { serviceWorker?: unknown }).serviceWorker,
    pushManager: (window as { PushManager?: unknown }).PushManager,
    notification: (window as { Notification?: unknown }).Notification,
  };

  afterEach(() => {
    // Restore whatever jsdom provided so we don't leak stubs across tests.
    if (original.serviceWorker === undefined) {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
    if (original.pushManager === undefined) delete (window as { PushManager?: unknown }).PushManager;
    if (original.notification === undefined) {
      delete (window as { Notification?: unknown }).Notification;
    }
  });

  it('is false when the Push API is absent (jsdom default)', () => {
    // jsdom exposes neither PushManager nor a service worker container.
    expect(isPushSupported()).toBe(false);
  });

  it('is true when all three capabilities are present', () => {
    (navigator as { serviceWorker?: unknown }).serviceWorker = {};
    (window as { PushManager?: unknown }).PushManager = function () {};
    (window as { Notification?: unknown }).Notification = function () {};
    expect(isPushSupported()).toBe(true);
  });
});

describe('socketTransport', () => {
  it('hands the subscription to the old server, bounded by a timeout', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const timeout = vi.fn(() => ({ emitWithAck }));
    const emit = vi.fn();
    const socket = { timeout, emit } as unknown as Parameters<typeof socketTransport>[0];

    const transport = socketTransport(socket);
    await expect(transport.subscribe({ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } })).resolves.toEqual({ ok: true });
    transport.unsubscribe();

    expect(timeout).toHaveBeenCalledWith(expect.any(Number));
    expect(emitWithAck).toHaveBeenCalledWith('push_subscribe', { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } });
    expect(emit).toHaveBeenCalledWith('push_unsubscribe');
  });
});

describe('connectionTransport', () => {
  function fakeConnection() {
    const request = vi.fn().mockResolvedValue({ ok: true });
    return { request, connection: { request } as unknown as GameConnection };
  }

  it("subscribes over the Game's own socket", async () => {
    const { request, connection } = fakeConnection();
    const subscription = { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } };

    await expect(connectionTransport(connection).subscribe(subscription)).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledWith('push_subscribe', subscription);
  });

  it('unsubscribes without waiting for the reply, and never throws', async () => {
    const request = vi.fn().mockRejectedValue(new Error('disconnected'));
    const connection = { request } as unknown as GameConnection;

    expect(() => connectionTransport(connection).unsubscribe()).not.toThrow();

    expect(request).toHaveBeenCalledWith('push_unsubscribe', undefined);
  });
});

/** A browser that can do Web Push, with a granted permission. */
function pushCapableBrowser({ existing }: { existing?: { toJSON: () => unknown } } = {}) {
  const subscribe = vi.fn(async () => ({
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/fresh', keys: { p256dh: 'p', auth: 'a' } }),
  }));
  const getSubscription = vi.fn(async () => existing ?? null);
  const unsubscribe = vi.fn(async () => true);
  const requestPermission = vi.fn(async () => 'granted');
  vi.stubGlobal('navigator', {
    ...navigator,
    serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }) },
  });
  vi.stubGlobal('PushManager', function PushManagerStub() {});
  vi.stubGlobal('Notification', { requestPermission, permission: 'default' });
  return { subscribe, getSubscription, unsubscribe, requestPermission };
}

/** A transport that records what it was handed. */
function fakeTransport(ack: { ok: boolean } = { ok: true }): PushTransport & { sent: unknown[]; dropped: number } {
  const transport = {
    sent: [] as unknown[],
    dropped: 0,
    subscribe(subscription: unknown) {
      transport.sent.push(subscription);
      return Promise.resolve(ack as Awaited<ReturnType<PushTransport['subscribe']>>);
    },
    unsubscribe() {
      transport.dropped += 1;
    },
  };
  return transport;
}

describe('enablePush', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports unsupported without touching the transport', async () => {
    // jsdom has no Push API, so this exercises the guard.
    const transport = fakeTransport();

    expect(await enablePush(transport)).toEqual({ ok: false, reason: 'unsupported' });
    expect(transport.sent).toEqual([]);
  });

  it("subscribes with the server's key and hands the subscription over", async () => {
    const browser = pushCapableBrowser();
    const transport = fakeTransport();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ key: 'aGk' }) });

    expect(await enablePush(transport, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: true });

    expect(browser.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(transport.sent).toEqual([
      { endpoint: 'https://fcm.googleapis.com/fcm/send/fresh', keys: { p256dh: 'p', auth: 'a' } },
    ]);
  });

  it('reuses a subscription the browser already has', async () => {
    const existing = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/old' }) };
    const browser = pushCapableBrowser({ existing });
    const transport = fakeTransport();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ key: 'aGk' }) });

    expect(await enablePush(transport, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: true });

    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/old' }]);
  });

  it('never prompts for permission when the server has push off', async () => {
    const browser = pushCapableBrowser();
    const transport = fakeTransport();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ key: null }) });

    expect(await enablePush(transport, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });

  it('reports a rejected subscribe as an error', async () => {
    pushCapableBrowser();
    const transport = fakeTransport({ ok: false });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ key: 'aGk' }) });

    expect(await enablePush(transport, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({
      ok: false,
      reason: 'error',
    });
  });
});

describe('disablePush', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells the server to forget the player even when the browser has no subscription', async () => {
    pushCapableBrowser();
    const transport = fakeTransport();

    await disablePush(transport);

    expect(transport.dropped).toBe(1);
  });
});
