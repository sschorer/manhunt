/**
 * Pure geometry helpers for the live map: turning a play-area definition into
 * the GeoJSON the map overlays. Kept free of any MapLibre or DOM dependency so
 * the maths is unit-testable on its own and the map component stays a thin
 * rendering shell over it.
 */

/** A longitude/latitude pair — MapLibre's `[lng, lat]` order, named. */
export interface LngLat {
  lng: number;
  lat: number;
}

/**
 * A circular play area: a centre and a radius in metres. This is a stand-in for
 * a server-configured play area (BACKLOG.md #11/#27). Until the server sends a
 * per-game boundary, the client anchors a default circle to the first own fix
 * so the overlay has something real to draw and the map screen is complete.
 */
export interface BoundaryCircle {
  center: LngLat;
  radiusM: number;
}

/** Default play-area radius, in metres, until the server configures one. */
export const DEFAULT_BOUNDARY_RADIUS_M = 500;

/** Mean Earth radius in metres (WGS84 sphere approximation). */
const EARTH_RADIUS_M = 6_371_008.8;

/** A GeoJSON `[lng, lat]` coordinate. */
export type Position = [number, number];

/** A closed GeoJSON Polygon feature — the shape a map source consumes. */
export interface PolygonFeature {
  type: 'Feature';
  properties: Record<string, never>;
  geometry: {
    type: 'Polygon';
    coordinates: Position[][];
  };
}

/**
 * Approximate a geographic circle as a closed ring of `[lng, lat]` points. Uses
 * an equirectangular offset around the centre — accurate to within metres at
 * play-area scale (hundreds of metres to a few km), which is all the overlay
 * needs. The ring is explicitly closed (the first point is repeated at the end)
 * as GeoJSON linear rings require.
 */
export function circleRing(center: LngLat, radiusM: number, steps = 64): Position[] {
  const ring: Position[] = [];
  const latRad = (center.lat * Math.PI) / 180;
  // Metres per degree of latitude, and of longitude at this latitude.
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);
  for (let i = 0; i < steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const dLng = mPerDegLng === 0 ? 0 : (radiusM * Math.cos(theta)) / mPerDegLng;
    const dLat = (radiusM * Math.sin(theta)) / mPerDegLat;
    ring.push([center.lng + dLng, center.lat + dLat]);
  }
  const first = ring[0];
  if (first) ring.push(first);
  return ring;
}

/** A GeoJSON Polygon feature for a boundary circle, ready for a map source. */
export function boundaryFeature(boundary: BoundaryCircle): PolygonFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [circleRing(boundary.center, boundary.radiusM)],
    },
  };
}
