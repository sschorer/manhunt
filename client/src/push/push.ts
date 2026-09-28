/**
 * Client-side Web Push wiring: turn the browser's Push API into a subscription
 * the Game can deliver to, and hand that subscription over the Game's own socket.
 * The matching service-worker listeners live in `public/push-sw.js`; the server
 * side is `server/push/`.
 *
 * The subscription reaches the Game through a {@link PushTransport}, which is
 * also what says *who* is subscribing. Everything else — the permission prompt,
 * the VAPID key, the browser subscription — is transport-independent and lives
 * here.
 *
 * Web Push is entirely opt-in and best-effort. Every failure mode — no support, a
 * denied permission, push off server-side, an unreachable server — is a typed
 * outcome the UI can render, never a thrown error, mirroring the way the
 * GPS/wake-lock hooks fail soft.
 */
import { INBOUND_EVENTS, type OkAck, type PushSubscription } from '@manhunt/shared';
import type { GameConnection } from '../transport/gameConnection.ts';

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

/**
 * How a subscription reaches the Game, and how the player is dropped again. The
 * Game files a subscription against the Seat the connection speaks for.
 */
export interface PushTransport {
  subscribe(subscription: PushSubscription): Promise<OkAck>;
  /** Tell the Game to forget this player. Best-effort: nothing waits for it. */
  unsubscribe(): void;
}

/** A request on the Game's own socket, which already times out and never resends. */
export function connectionTransport(connection: GameConnection): PushTransport {
  return {
    subscribe: (subscription) => connection.request<OkAck>(INBOUND_EVENTS.pushSubscribe, subscription),
    unsubscribe: () => {
      // The player is opting out; a Game that never heard it has nowhere to push
      // to anyway once the browser subscription is gone.
      void connection.request<OkAck>(INBOUND_EVENTS.pushUnsubscribe, undefined).catch(() => undefined);
    },
  };
}

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
 * Opt the current player in to Web Push. Fetches the VAPID key, requests
 * notification permission, subscribes via the ready service worker, and hands the
 * subscription to the Game over `transport` — which files it against the Seat
 * that transport speaks for. Reuses an existing browser subscription where one is
 * present.
 */
export async function enablePush(
  transport: PushTransport,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PushEnableResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  // Check the server is actually offering push before prompting: with no VAPID
  // key configured there's nothing to subscribe to, so we shouldn't pop the
  // browser's permission dialog only to bail out.
  const key = await fetchVapidPublicKey(deps.fetchImpl ?? fetch);
  if (!key) return { ok: false, reason: 'disabled' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      }));

    const ack = await transport.subscribe(subscription.toJSON() as PushSubscription);
    return ack.ok ? { ok: true } : { ok: false, reason: 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * Opt back out: drop the browser subscription and tell the Game to forget it.
 * Best-effort — a failure to reach the push service or the Game is swallowed,
 * since the goal (no more pushes) is served either way.
 */
export async function disablePush(transport: PushTransport): Promise<void> {
  try {
    if (isPushSupported()) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
  } catch {
    // Ignore — we still tell the server to drop us below.
  }
  transport.unsubscribe();
}
