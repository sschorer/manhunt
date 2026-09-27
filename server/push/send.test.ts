import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { caughtNotification, revealNotification } from './notifications.ts';
import { createTestSubscription, type TestSubscription } from './testing.ts';
import { PUSH_TIMEOUT_MS, sendPush } from './send.ts';

const VAPID = {
  publicKey: 'BKj0Is4B9JfkdTHC1pMK6rYDKcHnNU1kOElKlpwmkIG4YxMhnShG2QkztefWEwr70zT97YPqIDNjRd83mFIY6uM',
  privateKey: 'dEGyK-Cc1CudWvOpZMZMALqu65QutXz22_cmtPh8U04',
  subject: 'mailto:ada@example.com',
};

const GAME_ID = 'game-1';

interface Delivered {
  url: string;
  init: RequestInit;
}

/** A push service that answers with `status` and records what it was sent. */
function pushService(status = 201): { fetch: typeof fetch; delivered: Delivered[] } {
  const delivered: Delivered[] = [];
  return {
    delivered,
    fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
      delivered.push({ url: String(url), init });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
  };
}

let test: TestSubscription;

beforeEach(async () => {
  test = await createTestSubscription();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendPush', () => {
  it('delivers the notification encrypted for the subscription', async () => {
    const service = pushService();

    const outcome = await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch);

    expect(outcome).toBe('sent');
    const [delivered] = service.delivered;
    expect(delivered?.url).toBe(test.subscription.endpoint);
    expect(delivered?.init.method).toBe('POST');
    expect(await test.decrypt(delivered?.init.body as ArrayBuffer)).toEqual({
      title: "You've been caught!",
      body: "A hunter tagged you — you're on the hunt now.",
      tag: `manhunt:${GAME_ID}:caught`,
      data: { gameId: GAME_ID, kind: 'caught' },
    });
  });

  it('identifies itself with VAPID and says how the payload is encrypted', async () => {
    const service = pushService();

    await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch);

    const headers = new Headers(service.delivered[0]?.init.headers);
    expect(headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${VAPID.publicKey}$`));
    expect(headers.get('content-encoding')).toBe('aes128gcm');
  });

  it("carries each notification's own ttl, urgency and topic", async () => {
    const service = pushService();

    await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch);
    await sendPush(test.subscription, revealNotification(GAME_ID), VAPID, service.fetch);

    const caught = new Headers(service.delivered[0]?.init.headers);
    expect(caught.get('ttl')).toBe('3600');
    expect(caught.get('urgency')).toBe('high');
    expect(caught.get('topic')).toBeNull();
    const reveal = new Headers(service.delivered[1]?.init.headers);
    expect(reveal.get('ttl')).toBe('180');
    expect(reveal.get('urgency')).toBe('normal');
    expect(reveal.get('topic')).toBe(`reveal-${GAME_ID}`);
  });

  it('follows no redirect, so nothing can bounce the push elsewhere', async () => {
    const service = pushService();

    await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch);

    expect(service.delivered[0]?.init.redirect).toBe('manual');
  });

  it('gives a push service ten seconds and no more', async () => {
    const service = pushService();
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch);

    expect(timeout).toHaveBeenCalledWith(PUSH_TIMEOUT_MS);
    expect(PUSH_TIMEOUT_MS).toBe(10_000);
    expect(service.delivered[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([404, 410])('reports a subscription the push service no longer has (%i) as gone', async (status) => {
    const service = pushService(status);

    expect(await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch)).toBe('gone');
  });

  it.each([
    ['a push service that is having trouble', 500],
    ['a rejected push', 400],
    ['a redirect', 302],
  ])('reports %s as a failure, logged without the endpoint', async (_label, status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = pushService(status);

    expect(await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, service.fetch)).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain('push_failed');
    expect(logged).toContain(String(status));
    expect(logged).not.toContain(test.subscription.endpoint);
  });

  it('reports a push that never got through as a failure, logged without the endpoint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unreachable = (() => Promise.reject(new Error('The operation was aborted'))) as unknown as typeof fetch;

    expect(await sendPush(test.subscription, caughtNotification(GAME_ID), VAPID, unreachable)).toBe('failed');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(test.subscription.endpoint);
  });

  it('treats a stored endpoint that is no push service as gone, and never dials it', async () => {
    const service = pushService();
    const elsewhere = { ...test.subscription, endpoint: 'https://evil.example/steal' };

    expect(await sendPush(elsewhere, caughtNotification(GAME_ID), VAPID, service.fetch)).toBe('gone');
    expect(service.delivered).toEqual([]);
  });
});
