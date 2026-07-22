import { describe, expect, it } from 'vitest';
import {
  bearingDegrees,
  boundaryFeature,
  circleRing,
  compassDirection,
  DEFAULT_BOUNDARY_RADIUS_M,
  distanceMeters,
  type BoundaryCircle,
} from './geo.ts';

/** Great-circle-ish distance in metres between two points (haversine). */
function distanceM(a: [number, number], b: [number, number]): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('circleRing', () => {
  const center = { lng: 4.9, lat: 52.37 };

  it('returns a closed ring (first point repeated at the end)', () => {
    const ring = circleRing(center, 500, 32);
    expect(ring).toHaveLength(33); // 32 points + the closing repeat
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('places every point at roughly the requested radius from the centre', () => {
    const radius = 500;
    const ring = circleRing(center, radius, 64);
    for (const point of ring) {
      const d = distanceM([center.lng, center.lat], point);
      // Equirectangular approximation: within a few metres at play-area scale.
      expect(Math.abs(d - radius)).toBeLessThan(5);
    }
  });

  it('does not divide by zero at the poles', () => {
    const ring = circleRing({ lng: 0, lat: 90 }, 500, 8);
    for (const [lng, latVal] of ring) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(latVal)).toBe(true);
    }
  });
});

describe('distanceMeters', () => {
  const amsterdam = { lng: 4.9, lat: 52.37 };

  it('is zero for a point to itself', () => {
    expect(distanceMeters(amsterdam, amsterdam)).toBe(0);
  });

  it('agrees with an independent haversine to within a metre', () => {
    const other = { lng: 4.91, lat: 52.375 };
    expect(distanceMeters(amsterdam, other)).toBeCloseTo(distanceM([4.9, 52.37], [4.91, 52.375]), 0);
  });

  it('is symmetric', () => {
    const a = { lng: 4.9, lat: 52.37 };
    const b = { lng: 5.1, lat: 52.4 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
  });
});

describe('bearingDegrees / compassDirection', () => {
  const origin = { lng: 0, lat: 0 };

  it('reads due north for a point directly above', () => {
    const bearing = bearingDegrees(origin, { lng: 0, lat: 1 });
    expect(bearing).toBeCloseTo(0, 1);
    expect(compassDirection(bearing)).toBe('north');
  });

  it('reads due east for a point directly to the right', () => {
    const bearing = bearingDegrees(origin, { lng: 1, lat: 0 });
    expect(bearing).toBeCloseTo(90, 1);
    expect(compassDirection(bearing)).toBe('east');
  });

  it('reads roughly northeast for a diagonal', () => {
    const bearing = bearingDegrees(origin, { lng: 1, lat: 1 });
    expect(compassDirection(bearing)).toBe('northeast');
  });

  it('snaps a wrapped bearing back to north', () => {
    expect(compassDirection(359)).toBe('north');
    expect(compassDirection(-90)).toBe('west');
  });
});

describe('boundaryFeature', () => {
  it('wraps the ring in a GeoJSON Polygon feature', () => {
    const boundary: BoundaryCircle = {
      center: { lng: 4.9, lat: 52.37 },
      radiusM: DEFAULT_BOUNDARY_RADIUS_M,
    };
    const feature = boundaryFeature(boundary);
    expect(feature.type).toBe('Feature');
    expect(feature.geometry.type).toBe('Polygon');
    expect(feature.geometry.coordinates).toHaveLength(1);
    const ring = feature.geometry.coordinates[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });
});
