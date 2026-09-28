/**
 * Ground geometry for the game core: how far apart two fixes are, and how far a
 * fix sits outside a Boundary. Pure, web-standard TypeScript — the two
 * measurements every authoritative decision that depends on distance is made
 * from (the Catch radius, the Boundary geofence, the speed plausibility guard).
 */
import type { BoundaryCircle } from '../../shared/index.ts';

/** Mean Earth radius, for great-circle distance between two fixes. */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Convert degrees to radians. */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle (haversine) distance between two lat/lng points, in metres. Exact
 * enough at the scale of a play area, and cheap enough to run on every tick.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far a position sits outside a Boundary, in metres. `0` when the point is
 * inside or exactly on the radius — this is the geofence test itself.
 */
export function metersOutside(
  boundary: BoundaryCircle,
  pos: { lat: number; lng: number },
): number {
  return Math.max(0, haversineMeters(boundary.center, pos) - boundary.radiusM);
}
