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

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Great-circle (haversine) distance between two points, in metres. This mirrors
 * the server's `haversineMeters` so the client can size the "how close is the
 * nearest player" readouts the same way the authoritative catch/boundary checks
 * do — the client's number is advisory (the server re-measures), so it only has
 * to agree to within GPS jitter.
 */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial compass bearing from `from` to `to`, in degrees clockwise from north
 * (`[0, 360)`). Used to turn "the nearest hider is 90 m away" into a direction
 * the player can act on ("…to the northeast").
 */
export function bearingDegrees(from: LngLat, to: LngLat): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The eight compass points, indexed clockwise from north in 45° steps. */
const COMPASS_POINTS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

/** Round a bearing in degrees to the nearest of the eight named compass points. */
export function compassDirection(bearing: number): string {
  const normalized = ((bearing % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return COMPASS_POINTS[index]!;
}
