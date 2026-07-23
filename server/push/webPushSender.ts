/**
 * The production {@link PushSender}: a thin adapter over the `web-push` library,
 * which does the heavy lifting of the Web Push protocol — signing the VAPID JWT
 * and encrypting the payload for the subscription's keys (RFC 8291) — before
 * POSTing it to the push service. The notifier's routing logic (see
 * `notifier.ts`) is deliberately kept clear of this so it can be tested with a
 * fake sender; only the real server wiring pulls this in.
 *
 * A send is normalized to a {@link PushSendResult}: success, or a failure that
 * flags whether the subscription is permanently **gone** (HTTP 404/410) so the
 * notifier prunes it. Every other error (a transient 5xx, a network blip) is a
 * non-gone failure — the subscription stays put for the next event.
 */
import webpush from 'web-push';
import type { PushSender, PushSendResult, PushPayload } from './notifier.ts';
import { createGuardedHttpsAgent } from './ssrf.ts';
import type { PushSubscription } from './subscriptions.ts';
import type { VapidConfig } from './vapid.ts';

/** HTTP statuses a push service returns when a subscription no longer exists. */
const GONE_STATUS = new Set([404, 410]);

/**
 * Socket timeout (ms) for a single push request. `web-push` leaves this unset by
 * default, so a push endpoint that accepts the connection but never responds
 * could hold a request — and back up the event fan-out — indefinitely. A bounded
 * timeout makes a stalled push fail fast; the failure is transient (no
 * gone-status), so the subscription survives for the next event.
 */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Build a sender that delivers via `web-push`, authenticated with the given VAPID
 * config. Call once with the resolved config (see `resolveVapidConfig`); the
 * VAPID details are applied per-send so this holds no global library state.
 */
export function createWebPushSender(config: VapidConfig): PushSender {
  const vapidDetails = {
    subject: config.subject,
    publicKey: config.publicKey,
    privateKey: config.privateKey,
  };
  // A single guarded agent for every push: its DNS lookup refuses to connect to a
  // hostname that resolves into private/reserved space, closing the DNS-rebinding
  // SSRF gap the subscribe-time literal-IP check can't see (server/push/ssrf.ts).
  const agent = createGuardedHttpsAgent();

  return {
    async send(subscription: PushSubscription, payload: PushPayload): Promise<PushSendResult> {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails,
          timeout: SEND_TIMEOUT_MS,
          agent,
        });
        return { ok: true };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: statusCode !== undefined && GONE_STATUS.has(statusCode) };
      }
    },
  };
}
