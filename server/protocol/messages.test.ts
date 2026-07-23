import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_RADIUS_RANGE,
  validateClaimCatch,
  validateJoin,
  validatePositionUpdate,
  validatePushSubscription,
  validateSetBoundary,
} from './messages.ts';

describe('validateJoin', () => {
  it('accepts a payload with a gameId', () => {
    expect(validateJoin({ gameId: 'g1' })).toEqual({ ok: true, value: { gameId: 'g1' } });
  });

  it.each([undefined, null, 'g1', 42])('rejects non-objects: %s', (payload) => {
    const res = validateJoin(payload);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('invalid_payload');
  });

  it.each([{}, { gameId: '' }, { gameId: 7 }])('rejects a missing/empty gameId: %o', (payload) => {
    const res = validateJoin(payload);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('game_id_required');
  });
});

describe('validatePositionUpdate', () => {
  it('accepts a well-formed update', () => {
    const res = validatePositionUpdate({ gameId: 'g1', playerId: 'p1', lat: 52.37, lng: 4.9 });
    expect(res).toEqual({ ok: true, value: { gameId: 'g1', playerId: 'p1', lat: 52.37, lng: 4.9 } });
  });

  it('does not invent a timestamp (the server stamps recordedAt)', () => {
    const res = validatePositionUpdate({ gameId: 'g1', playerId: 'p1', lat: 0, lng: 0 });
    if (!res.ok) throw new Error('expected valid');
    expect(res.value).not.toHaveProperty('recordedAt');
  });

  it('requires gameId and playerId', () => {
    expect(validatePositionUpdate({ playerId: 'p1', lat: 1, lng: 2 }).ok).toBe(false);
    const missingPlayer = validatePositionUpdate({ gameId: 'g1', lat: 1, lng: 2 });
    if (missingPlayer.ok) throw new Error('expected invalid');
    expect(missingPlayer.code).toBe('player_id_required');
  });

  it.each([
    ['non-numeric lat', { gameId: 'g', playerId: 'p', lat: 'x', lng: 2 }],
    ['NaN lng', { gameId: 'g', playerId: 'p', lat: 1, lng: Number.NaN }],
    ['lat out of range', { gameId: 'g', playerId: 'p', lat: 91, lng: 2 }],
    ['lng out of range', { gameId: 'g', playerId: 'p', lat: 1, lng: 181 }],
    ['lat below range', { gameId: 'g', playerId: 'p', lat: -91, lng: 2 }],
  ])('rejects bad coordinates: %s', (_label, payload) => {
    const res = validatePositionUpdate(payload);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('invalid_coordinates');
  });

  it('accepts the coordinate extremes', () => {
    expect(validatePositionUpdate({ gameId: 'g', playerId: 'p', lat: -90, lng: -180 }).ok).toBe(true);
    expect(validatePositionUpdate({ gameId: 'g', playerId: 'p', lat: 90, lng: 180 }).ok).toBe(true);
  });
});

describe('validateClaimCatch', () => {
  it('accepts a hunter catching a different target', () => {
    const res = validateClaimCatch({ gameId: 'g1', hunterId: 'h1', targetId: 't1' });
    expect(res).toEqual({ ok: true, value: { gameId: 'g1', hunterId: 'h1', targetId: 't1' } });
  });

  it('requires gameId, hunterId and targetId', () => {
    expect(validateClaimCatch({ hunterId: 'h', targetId: 't' }).ok).toBe(false);
    const noHunter = validateClaimCatch({ gameId: 'g', targetId: 't' });
    if (noHunter.ok) throw new Error('expected invalid');
    expect(noHunter.code).toBe('hunter_id_required');
    const noTarget = validateClaimCatch({ gameId: 'g', hunterId: 'h' });
    if (noTarget.ok) throw new Error('expected invalid');
    expect(noTarget.code).toBe('target_id_required');
  });

  it('rejects a hunter catching themselves', () => {
    const res = validateClaimCatch({ gameId: 'g1', hunterId: 'same', targetId: 'same' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('self_catch');
  });
});

describe('validateSetBoundary', () => {
  const boundary = { center: { lat: 52.3731, lng: 4.8922 }, radiusM: 500 };

  it('accepts a well-formed circular boundary', () => {
    const res = validateSetBoundary({ boundary });
    expect(res).toEqual({ ok: true, value: { boundary } });
  });

  it('keeps only the recognized boundary fields', () => {
    const res = validateSetBoundary({
      boundary: { center: { lat: 1, lng: 2, extra: 'x' }, radiusM: 100, name: 'zone' },
      junk: true,
    });
    if (!res.ok) throw new Error('expected valid');
    expect(res.value).toEqual({ boundary: { center: { lat: 1, lng: 2 }, radiusM: 100 } });
  });

  it.each([undefined, null, 'boundary', 42])('rejects non-objects: %s', (payload) => {
    expect(validateSetBoundary(payload).ok).toBe(false);
  });

  it('requires a boundary object', () => {
    const res = validateSetBoundary({});
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('boundary_required');
  });

  it.each([
    ['missing center', { boundary: { radiusM: 500 } }],
    ['non-object center', { boundary: { center: 'here', radiusM: 500 } }],
    ['lat out of range', { boundary: { center: { lat: 91, lng: 2 }, radiusM: 500 } }],
    ['lng out of range', { boundary: { center: { lat: 1, lng: 181 }, radiusM: 500 } }],
    ['NaN lat', { boundary: { center: { lat: Number.NaN, lng: 2 }, radiusM: 500 } }],
  ])('rejects a bad centre: %s', (_label, payload) => {
    const res = validateSetBoundary(payload);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('invalid_center');
  });

  it.each([
    ['zero radius', 0],
    ['negative radius', -5],
    ['NaN radius', Number.NaN],
    ['above the max', BOUNDARY_RADIUS_RANGE.max + 1],
  ])('rejects a bad radius: %s', (_label, radiusM) => {
    const res = validateSetBoundary({ boundary: { center: { lat: 1, lng: 2 }, radiusM } });
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('invalid_radius');
  });

  it('accepts the radius extremes', () => {
    for (const radiusM of [BOUNDARY_RADIUS_RANGE.min, BOUNDARY_RADIUS_RANGE.max]) {
      expect(validateSetBoundary({ boundary: { center: { lat: 0, lng: 0 }, radiusM } }).ok).toBe(true);
    }
  });
});

describe('validatePushSubscription', () => {
  const good = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'key', auth: 'auth' } };

  it('accepts a well-formed subscription and keeps only recognized fields', () => {
    const res = validatePushSubscription({ ...good, expirationTime: null, extra: 'nope' });
    expect(res).toEqual({ ok: true, value: good });
  });

  it.each([undefined, null, 'sub', 42])('rejects non-objects: %s', (payload) => {
    const res = validatePushSubscription(payload);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('invalid_payload');
  });

  it.each([
    ['missing endpoint', { keys: { p256dh: 'k', auth: 'a' } }],
    ['empty endpoint', { endpoint: '', keys: { p256dh: 'k', auth: 'a' } }],
    ['non-string endpoint', { endpoint: 5, keys: { p256dh: 'k', auth: 'a' } }],
  ])('rejects a bad endpoint: %s', (_label, payload) => {
    const res = validatePushSubscription(payload);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('endpoint_required');
  });

  it.each([
    ['missing keys', { endpoint: 'https://push.example.com/abc' }],
    ['missing p256dh', { endpoint: 'https://push.example.com/abc', keys: { auth: 'a' } }],
    ['missing auth', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k' } }],
    ['empty auth', { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'k', auth: '' } }],
  ])('rejects bad keys: %s', (_label, payload) => {
    const res = validatePushSubscription(payload);
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('keys_required');
  });

  it.each([
    ['not a url', 'not-a-url'],
    ['plain http', 'http://push.example.com/abc'],
    ['loopback', 'https://127.0.0.1/abc'],
    ['localhost', 'https://localhost/abc'],
    ['ipv6 loopback', 'https://[::1]/abc'],
    ['private 10/8', 'https://10.0.0.5/abc'],
    ['private 192.168', 'https://192.168.1.20/abc'],
    ['private 172.16', 'https://172.16.9.9/abc'],
    ['link-local', 'https://169.254.169.254/latest/meta-data'],
  ])('rejects an unsafe endpoint: %s', (_label, endpoint) => {
    const res = validatePushSubscription({ endpoint, keys: { p256dh: 'k', auth: 'a' } });
    if (res.ok) throw new Error('expected invalid');
    expect(res.code).toBe('invalid_endpoint');
  });

  it('accepts a public https endpoint on a non-private host', () => {
    const res = validatePushSubscription({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'k', auth: 'a' },
    });
    expect(res.ok).toBe(true);
  });
});
