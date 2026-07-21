import { describe, expect, it } from 'vitest';
import {
  boundaryFeature,
  circleRing,
  DEFAULT_BOUNDARY_RADIUS_M,
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
