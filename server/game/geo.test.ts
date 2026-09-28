import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_M, haversineMeters, metersOutside } from './geo.ts';

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters({ lat: 52.37, lng: 4.9 }, { lat: 52.37, lng: 4.9 })).toBe(0);
  });

  it('measures one minute of latitude as about a nautical mile', () => {
    // 1' of latitude ≈ 1852 m by definition of the nautical mile.
    const meters = haversineMeters({ lat: 0, lng: 0 }, { lat: 1 / 60, lng: 0 });
    expect(meters).toBeGreaterThan(1840);
    expect(meters).toBeLessThan(1860);
  });

  it('measures a quarter of the way around the globe as a quarter of its circumference', () => {
    const quarter = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 90 });
    expect(quarter).toBeCloseTo((Math.PI / 2) * EARTH_RADIUS_M, 0);
  });

  it('is symmetric', () => {
    const a = { lat: 52.37, lng: 4.9 };
    const b = { lat: 52.38, lng: 4.92 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
  });
});

describe('metersOutside', () => {
  const boundary = { center: { lat: 52.37, lng: 4.9 }, radiusM: 500 };

  it('is zero inside the Boundary', () => {
    expect(metersOutside(boundary, boundary.center)).toBe(0);
  });

  it('is zero exactly on the radius', () => {
    // A point ~500 m north: 500 m is 500 / (2πR/360) degrees of latitude.
    const degreesPer500m = 500 / ((2 * Math.PI * EARTH_RADIUS_M) / 360);
    const onEdge = { lat: boundary.center.lat + degreesPer500m, lng: boundary.center.lng };
    expect(metersOutside(boundary, onEdge)).toBeCloseTo(0, 6);
  });

  it('reports the overshoot outside the Boundary', () => {
    const degreesPer1km = 1_000 / ((2 * Math.PI * EARTH_RADIUS_M) / 360);
    const outside = { lat: boundary.center.lat + degreesPer1km, lng: boundary.center.lng };
    expect(metersOutside(boundary, outside)).toBeCloseTo(500, 0);
  });
});
