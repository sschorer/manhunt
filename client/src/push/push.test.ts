import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enablePush,
  fetchVapidPublicKey,
  isPushSupported,
  urlBase64ToUint8Array,
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

describe('enablePush', () => {
  it('reports unsupported without touching the socket', async () => {
    // jsdom has no Push API, so this exercises the guard.
    const emitWithAck = vi.fn();
    const socket = { emitWithAck } as unknown as Parameters<typeof enablePush>[0];
    const result = await enablePush(socket);
    expect(result).toEqual({ ok: false, reason: 'unsupported' });
    expect(emitWithAck).not.toHaveBeenCalled();
  });
});
