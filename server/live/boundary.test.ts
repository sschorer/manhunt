import { describe, expect, it } from 'vitest';
import {
  createBoundaryMonitor,
  DEFAULT_BOUNDARY_WARNINGS,
  isInsideBoundary,
  metersOutside,
  type BoundaryCircle,
} from './boundary.ts';

/** A 500 m circle centred on Amsterdam's Dam square, for the geofence tests. */
const boundary: BoundaryCircle = {
  center: { lat: 52.3731, lng: 4.8922 },
  radiusM: 500,
};

/**
 * A point due north of `boundary.center` by roughly `meters`. One degree of
 * latitude is ~111.32 km, enough precision to sit a fix a known distance out.
 */
function northOf(center: { lat: number; lng: number }, meters: number): { lat: number; lng: number } {
  return { lat: center.lat + meters / 111_320, lng: center.lng };
}

describe('metersOutside / isInsideBoundary', () => {
  it('reports zero and inside for the centre', () => {
    expect(metersOutside(boundary, boundary.center)).toBe(0);
    expect(isInsideBoundary(boundary, boundary.center)).toBe(true);
  });

  it('reports zero and inside for a point within the radius', () => {
    const near = northOf(boundary.center, 300);
    expect(metersOutside(boundary, near)).toBe(0);
    expect(isInsideBoundary(boundary, near)).toBe(true);
  });

  it('reports the overshoot and outside for a point beyond the radius', () => {
    const out = northOf(boundary.center, 800);
    // ~800 m from the centre of a 500 m circle → ~300 m outside.
    expect(metersOutside(boundary, out)).toBeGreaterThan(280);
    expect(metersOutside(boundary, out)).toBeLessThan(320);
    expect(isInsideBoundary(boundary, out)).toBe(false);
  });
});

describe('createBoundaryMonitor', () => {
  const inside = boundary.center;
  const outside = northOf(boundary.center, 900);

  it('reports inside with no change while the player stays in the area', () => {
    const monitor = createBoundaryMonitor();
    const v = monitor.evaluate({ gameId: 'g', playerId: 'p', position: inside, boundary });
    expect(v).toMatchObject({ status: 'inside', changed: false, warnings: 0, metersOutside: 0 });
    expect(v.warningsRemaining).toBe(DEFAULT_BOUNDARY_WARNINGS);
  });

  it('warns on exit, then eliminates on a continued exit (default policy = 1)', () => {
    const monitor = createBoundaryMonitor(); // one warning, then out
    const first = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(first).toMatchObject({ status: 'warned', changed: true, warnings: 1, warningsRemaining: 0 });
    expect(first.metersOutside).toBeGreaterThan(390);

    const second = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(second).toMatchObject({ status: 'eliminated', changed: true, warningsRemaining: 0 });
  });

  it('honours a custom warning count before eliminating', () => {
    const monitor = createBoundaryMonitor({ warningsBeforeElimination: 2 });
    const one = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(one).toMatchObject({ status: 'warned', warnings: 1, warningsRemaining: 1 });
    const two = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(two).toMatchObject({ status: 'warned', warnings: 2, warningsRemaining: 0 });
    const three = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(three).toMatchObject({ status: 'eliminated', changed: true });
  });

  it('eliminates on the first exit with a zero-warning policy', () => {
    const monitor = createBoundaryMonitor({ warningsBeforeElimination: 0 });
    const v = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(v).toMatchObject({ status: 'eliminated', changed: true, warnings: 1 });
  });

  it('resets the warning count when the player returns inside', () => {
    const monitor = createBoundaryMonitor({ warningsBeforeElimination: 2 });
    monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });

    const back = monitor.evaluate({ gameId: 'g', playerId: 'p', position: inside, boundary });
    expect(back).toMatchObject({ status: 'inside', changed: true, warnings: 0, warningsRemaining: 2 });

    // A fresh excursion starts the count over rather than resuming near elimination.
    const again = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(again).toMatchObject({ status: 'warned', warnings: 1, warningsRemaining: 1 });
  });

  it('stays eliminated idempotently, even back inside the area', () => {
    const monitor = createBoundaryMonitor({ warningsBeforeElimination: 0 });
    monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });

    const stillOut = monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    expect(stillOut).toMatchObject({ status: 'eliminated', changed: false });

    const backInside = monitor.evaluate({ gameId: 'g', playerId: 'p', position: inside, boundary });
    expect(backInside).toMatchObject({ status: 'eliminated', changed: false });
  });

  it('tracks players and games independently', () => {
    const monitor = createBoundaryMonitor({ warningsBeforeElimination: 0 });
    const a = monitor.evaluate({ gameId: 'g1', playerId: 'p1', position: outside, boundary });
    expect(a.status).toBe('eliminated');
    // A different player in a different game is unaffected.
    const b = monitor.evaluate({ gameId: 'g2', playerId: 'p1', position: inside, boundary });
    expect(b.status).toBe('inside');
    const c = monitor.evaluate({ gameId: 'g1', playerId: 'p2', position: inside, boundary });
    expect(c.status).toBe('inside');
  });

  it('forgets a game so a recycled id starts clean', () => {
    const monitor = createBoundaryMonitor({ warningsBeforeElimination: 0 });
    monitor.evaluate({ gameId: 'g', playerId: 'p', position: outside, boundary });
    monitor.forget('g');
    const afresh = monitor.evaluate({ gameId: 'g', playerId: 'p', position: inside, boundary });
    expect(afresh).toMatchObject({ status: 'inside', changed: false });
  });
});
