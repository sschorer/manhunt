/**
 * Delivering one notification to one subscription: the only part of Web Push that
 * talks to the outside world.
 *
 * `@block65/webcrypto-web-push` builds the request — the VAPID JWT and the
 * RFC 8291 `aes128gcm` payload, with WebCrypto — and we do the `fetch` ourselves,
 * which is what lets the endpoint check, the timeout and the redirect policy live
 * here. It runs inside the `GameRoom` Durable Object, where a push costs about
 * 1.6 ms of CPU; from the Worker it would blow the 10 ms limit (issue #68).
 *
 * A push is never retried. Every one of them is about a moment in a Game that has
 * already passed, so a second attempt would arrive after it stopped mattering.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { isPushServiceEndpoint, type PushSubscription } from '../../shared/index.ts';
import type { VapidKeys } from './keys.ts';
import type { PushNotification } from './notifications.ts';

/**
 * How long a push service has to answer. Long enough for a slow one, short enough
 * that the Game's own work — which a push never blocks anyway — is never held by
 * an endpoint that accepted the connection and then went quiet.
 */
export const PUSH_TIMEOUT_MS = 10_000;

/** What a push service said when a subscription no longer exists there. */
const GONE_STATUS = new Set([404, 410]);

/**
 * How a push ended:
 *
 * - `sent` — the push service took it.
 * - `gone` — the subscription no longer exists, or can no longer be delivered to.
 *   The Seat's subscription is dropped; nothing will ever reach it again.
 * - `failed` — this attempt didn't get through (a timeout, a 5xx, a redirect).
 *   The subscription stays for the next notification.
 */
export type PushOutcome = 'sent' | 'gone' | 'failed';

/** A failure, named but never traced back to the player: no endpoint, no name. */
function logFailure(reason: string): void {
  console.warn(JSON.stringify({ event: 'push_failed', reason }));
}

/**
 * Send one notification. The endpoint is checked again here, not only at
 * `push_subscribe`: this is the request that leaves the Worker, and an endpoint
 * that isn't a push service we deliver to can never be delivered to, so its
 * subscription is reported `gone` rather than dialled.
 */
export async function sendPush(
  subscription: PushSubscription,
  notification: PushNotification,
  vapid: VapidKeys,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  if (!isPushServiceEndpoint(subscription.endpoint)) {
    logFailure('endpoint_not_a_push_service');
    return 'gone';
  }
  try {
    const { headers, body } = await buildPushPayload(
      {
        // Serialized here rather than handed over as an object: the library would
        // stringify it the same way, and this is the JSON the service worker reads.
        data: JSON.stringify(notification.payload),
        options: {
          ttl: notification.ttl,
          urgency: notification.urgency,
          ...(notification.topic === undefined ? {} : { topic: notification.topic }),
        },
      },
      // The browser's `expirationTime` is nothing we keep, and nothing the
      // protocol sends; the library's type asks for it all the same.
      { ...subscription, expirationTime: null },
      vapid,
    );
    const response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers,
      body,
      // A push service answers 201 and never redirects, so a 3xx is something
      // else trying to take the payload somewhere we never checked.
      redirect: 'manual',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (response.ok) return 'sent';
    if (GONE_STATUS.has(response.status)) return 'gone';
    logFailure(`status_${response.status}`);
    return 'failed';
  } catch (error) {
    logFailure(error instanceof Error ? error.name : 'unknown');
    return 'failed';
  }
}
