import { describe, expect, it } from 'vitest';
import { createMemoryPositionStore } from './positions.ts';
import {
  createTickEngine,
  haversineMeters,
  MAX_PLAUSIBLE_SPEED_MPS,
} from './tick.ts';

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters({ lat: 52.37, lng: 4.9 }, { lat: 52.37, lng: 4.9 })).toBe(0);
  });

  it('measures a short distance to within a few metres', () => {
    // One arc-minute of latitude is ~1852 m (a nautical mile).
    const meters = haversineMeters({ lat: 0, lng: 0 }, { lat: 1 / 60, lng: 0 });
    expect(meters).toBeGreaterThan(1840);
    expect(meters).toBeLessThan(1860);
  });
});

describe('createTickEngine.ingest', () => {
  it('writes the first fix and returns the fresh snapshot', async () => {
    const store = createMemoryPositionStore();
    const engine = createTickEngine(store);

    const at = new Date('2026-07-22T00:00:00.000Z');
    const result = await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      role: 'hider',
      lat: 52.37,
      lng: 4.9,
      at,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).toEqual({
      lat: 52.37,
      lng: 4.9,
      recordedAt: at.toISOString(),
      role: 'hider',
    });
    expect(result.positions).toEqual({ p1: result.position });
    // The write is durable in the store, too.
    expect(await store.readPositions('g1')).toEqual({ p1: result.position });
  });

  it('stamps the current time when no `at` is given', async () => {
    const engine = createTickEngine(createMemoryPositionStore());
    const before = Date.now();
    const result = await engine.ingest({ gameId: 'g1', playerId: 'p1', lat: 1, lng: 2 });
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stamped = Date.parse(result.position.recordedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('omits role when the writer has none', async () => {
    const engine = createTickEngine(createMemoryPositionStore());
    const result = await engine.ingest({ gameId: 'g1', playerId: 'p1', lat: 1, lng: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).not.toHaveProperty('role');
  });

  it('accepts plausible movement between two fixes', async () => {
    const store = createMemoryPositionStore();
    const engine = createTickEngine(store);

    await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.37,
      lng: 4.9,
      at: new Date('2026-07-22T00:00:00.000Z'),
    });
    // ~66 m north over 10 s — a brisk jog, well within the limit.
    const second = await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.3706,
      lng: 4.9,
      at: new Date('2026-07-22T00:00:10.000Z'),
    });

    expect(second.ok).toBe(true);
    expect(await store.readPositions('g1')).toEqual({ p1: (second as { position: unknown }).position });
  });

  it('rejects an implausible jump without writing it', async () => {
    const store = createMemoryPositionStore();
    const engine = createTickEngine(store);

    const first = await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.37,
      lng: 4.9,
      at: new Date('2026-07-22T00:00:00.000Z'),
    });
    if (!first.ok) throw new Error('first fix should have been accepted');

    // ~110 km east in one second — a teleport no player could make.
    const jump = await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.37,
      lng: 6.5,
      at: new Date('2026-07-22T00:00:01.000Z'),
    });

    expect(jump).toEqual({ ok: false, reason: 'implausible_speed' });
    // The last good fix stands; the teleport was never stored.
    expect(await store.readPositions('g1')).toEqual({ p1: first.position });
  });

  it('does not treat two fixes in the same instant as an infinite-speed teleport', async () => {
    const engine = createTickEngine(createMemoryPositionStore());
    const at = new Date('2026-07-22T00:00:00.000Z');
    await engine.ingest({ gameId: 'g1', playerId: 'p1', lat: 52.37, lng: 4.9, at });
    // Same timestamp, a large jump: elapsed time is zero, so speed is unknowable
    // and the fix is allowed through rather than rejected as a division by zero.
    const same = await engine.ingest({ gameId: 'g1', playerId: 'p1', lat: 52.37, lng: 6.5, at });
    expect(same.ok).toBe(true);
  });

  it('honors a custom max speed', async () => {
    // A 1 m/s cap: the same jog that passes the default limit is now implausible.
    const engine = createTickEngine(createMemoryPositionStore(), { maxSpeedMps: 1 });
    await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.37,
      lng: 4.9,
      at: new Date('2026-07-22T00:00:00.000Z'),
    });
    const fast = await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 52.3706,
      lng: 4.9,
      at: new Date('2026-07-22T00:00:10.000Z'),
    });
    expect(fast).toEqual({ ok: false, reason: 'implausible_speed' });
  });

  it('serializes concurrent ticks for one player so the guard sees the latest fix', async () => {
    // Two ticks for the same player fired without awaiting the first. If the
    // read-check-write weren't serialized, both would read the seed as `previous`
    // and both would pass; the far jump would slip through. Serialized, the
    // second tick is checked against the first's accepted fix — a teleport — and
    // is rejected.
    const store = createMemoryPositionStore();
    const engine = createTickEngine(store);
    await engine.ingest({
      gameId: 'g1',
      playerId: 'p1',
      lat: 0,
      lng: 0,
      at: new Date('2026-07-22T00:00:00.000Z'),
    });

    const [near, far] = await Promise.all([
      // +100 s, ~1.1 km north of the seed — ~11 m/s, plausible.
      engine.ingest({
        gameId: 'g1',
        playerId: 'p1',
        lat: 0.01,
        lng: 0,
        at: new Date('2026-07-22T00:01:40.000Z'),
      }),
      // 1 s later, ~2.2 km back south of `near` — plausible vs the seed but a
      // teleport vs `near`, which is what the guard must compare against.
      engine.ingest({
        gameId: 'g1',
        playerId: 'p1',
        lat: -0.01,
        lng: 0,
        at: new Date('2026-07-22T00:01:41.000Z'),
      }),
    ]);

    expect(near.ok).toBe(true);
    expect(far).toEqual({ ok: false, reason: 'implausible_speed' });
    expect(await store.readPositions('g1')).toMatchObject({ p1: { lat: 0.01, lng: 0 } });
  });

  it('does not serialize across different players', async () => {
    // Distinct players must not block one another; both first fixes are accepted.
    const engine = createTickEngine(createMemoryPositionStore());
    const [a, b] = await Promise.all([
      engine.ingest({ gameId: 'g1', playerId: 'p1', lat: 1, lng: 1 }),
      engine.ingest({ gameId: 'g1', playerId: 'p2', lat: 2, lng: 2 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('checks plausibility per player, not across players', async () => {
    const engine = createTickEngine(createMemoryPositionStore());
    const at = new Date('2026-07-22T00:00:00.000Z');
    const later = new Date('2026-07-22T00:00:01.000Z');
    await engine.ingest({ gameId: 'g1', playerId: 'p1', lat: 52.37, lng: 4.9, at });
    // p2's first fix is far from p1's, but it's p2's *first* fix, so there's no
    // previous position to compare against — it must be accepted.
    const p2 = await engine.ingest({ gameId: 'g1', playerId: 'p2', lat: 52.37, lng: 6.5, at: later });
    expect(p2.ok).toBe(true);
  });

  it('defaults to the shared max-speed constant', () => {
    expect(MAX_PLAUSIBLE_SPEED_MPS).toBeGreaterThan(90);
  });
});

describe('createTickEngine.latest', () => {
  it('exposes every player’s latest position for the rules engine', async () => {
    const store = createMemoryPositionStore();
    const engine = createTickEngine(store);
    await engine.ingest({ gameId: 'g1', playerId: 'p1', role: 'hunter', lat: 1, lng: 2 });
    await engine.ingest({ gameId: 'g1', playerId: 'p2', role: 'hider', lat: 3, lng: 4 });

    const latest = await engine.latest('g1');
    expect(Object.keys(latest).sort()).toEqual(['p1', 'p2']);
    expect(latest.p1).toMatchObject({ lat: 1, lng: 2, role: 'hunter' });
    expect(latest.p2).toMatchObject({ lat: 3, lng: 4, role: 'hider' });
  });

  it('returns an empty snapshot for an unknown game', async () => {
    const engine = createTickEngine(createMemoryPositionStore());
    expect(await engine.latest('nope')).toEqual({});
  });
});
