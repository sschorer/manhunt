/**
 * Client-side Web Push wiring (BACKLOG.md #23): turn the browser's Push API into
 * a subscription the server can deliver to, and hand that subscription over the
 * socket. The matching service-worker listeners live in `public/push-sw.js`, and
 * the server side (VAPID config, per-game subscription store, notifier) lives in
 * `server/push/`.
 *
 * Web Push is entirely opt-in and best-effort. Every failure mode — no support,
 * a denied permission, push disabled server-side, an unreachable server — is a
 * typed outcome the UI can render, never a thrown error, mirroring the way the
 * GPS/wake-lock hooks fail soft.
 */
import type { Socket } from 'socket.io-client';
import { socket as defaultSocket } from '../socket.ts';

/** Why enabling push did or didn't succeed. */
export type PushEnableResult =
  | { ok: true }
  /** The browser lacks the Push API / service workers / notifications. */
  | { ok: false; reason: 'unsupported' }
  /** The user declined (or had previously blocked) notification permission. */
  | { ok: false; reason: 'denied' }
  /** The server has no VAPID key configured — the feature is off. */
  | { ok: false; reason: 'disabled' }
  /** Subscribing, or handing the subscription to the server, failed. */
  | { ok: false; reason: 'error' };

/** Whether this browser can do Web Push at all (SW + Push API + Notifications). */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Decode a base64url VAPID public key into the `Uint8Array` the Push API's
 * `applicationServerKey` requires. Base64url uses `-`/`_` and drops padding, so
 * we restore both before decoding.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Fetch the server's VAPID public key. Returns `null` — push disabled — when the
 * server advertises no key, or the request fails. The client reads `null` as
 * "don't try to subscribe".
 */
export async function fetchVapidPublicKey(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl('/api/push/vapid-public-key');
    if (!res.ok) return null;
    const body = (await res.json()) as { key?: string | null };
    return body.key ?? null;
  } catch {
    return null;
  }
}

/**
 * Opt the current player in to Web Push. Requests notification permission,
 * fetches the VAPID key, subscribes via the ready service worker, and hands the
 * subscription to the server over the socket (`push_subscribe`) — which files it
 * against the caller's game and player. Reuses an existing browser subscription
 * where one is present. Requires the socket to be in a game; the server rejects
 * a subscribe otherwise, surfaced here as `error`.
 */
export async function enablePush(
  socket: Socket = defaultSocket,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PushEnableResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const key = await fetchVapidPublicKey(deps.fetchImpl ?? fetch);
  if (!key) return { ok: false, reason: 'disabled' };

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      }));

    const ack = (await socket.emitWithAck('push_subscribe', subscription.toJSON())) as {
      ok: boolean;
    };
    return ack.ok ? { ok: true } : { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Opt back out: drop the browser subscription and tell the server to forget it
 * (`push_unsubscribe`). Best-effort — a failure to reach the push service or the
 * server is swallowed, since the goal (no more pushes) is served either way.
 */
export async function disablePush(socket: Socket = defaultSocket): Promise<void> {
  try {
    if (isPushSupported()) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
  } catch {
    // Ignore — we still tell the server to drop us below.
  }
  socket.emit('push_unsubscribe');
}
