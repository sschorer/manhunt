import { useEffect, useRef, useState } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { boundaryFeature, type BoundaryCircle, type LngLat } from './geo.ts';
import type { LivePositions } from './useLivePositions.ts';
import './GameMap.css';

/**
 * A self-contained raster style backed by the public OpenStreetMap tiles. It
 * needs no API key, so the map renders out of the box in dev and CI. Swap the
 * tile source for a proper provider (or a self-hosted vector style) before any
 * real deployment — OSM's tiles are not for production traffic.
 */
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const BOUNDARY_SOURCE = 'boundary';
const BOUNDARY_FILL = 'boundary-fill';
const BOUNDARY_LINE = 'boundary-line';

/** Zoom the map opens at once a position is known — street level for a chase. */
const PLAY_ZOOM = 15;

/** Empty feature collection used to clear a source. */
const EMPTY_DATA = { type: 'FeatureCollection' as const, features: [] };

export interface GameMapProps {
  /** The caller's own live position, drawn as the highlighted pin. */
  self: LngLat | null;
  /** The caller's own player id, so it can be excluded from {@link others}. */
  selfId: string | null;
  /** Every other permitted player's latest position, keyed by player id. */
  others: LivePositions;
  /** The play-area boundary to overlay, or `null` before one is known. */
  boundary: BoundaryCircle | null;
}

/** Build the DOM element MapLibre uses for a player pin. */
function makePin(kind: 'self' | 'other'): HTMLElement {
  const el = document.createElement('div');
  el.className = `map-pin map-pin--${kind}`;
  return el;
}

/**
 * The live match map: a MapLibre GL map that overlays the play-area boundary and
 * a pin for every player this client is permitted to see — the caller's own
 * position highlighted, everyone else from the server's fan-out. The map is
 * created once and then imperatively kept in sync as positions and the boundary
 * change; React only owns the container element.
 */
export default function GameMap({ self, selfId, others, boundary }: GameMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const centeredRef = useRef(false);
  const [loaded, setLoaded] = useState(false);

  // Create the map exactly once. It opens at a neutral world view when no
  // position is known yet; the recentre effect below snaps to the player as
  // soon as the first fix arrives.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const center = self ?? boundary?.center ?? { lng: 0, lat: 0 };
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [center.lng, center.lat],
      zoom: self || boundary ? PLAY_ZOOM : 1,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource(BOUNDARY_SOURCE, { type: 'geojson', data: EMPTY_DATA });
      map.addLayer({
        id: BOUNDARY_FILL,
        type: 'fill',
        source: BOUNDARY_SOURCE,
        paint: { 'fill-color': '#24e3c6', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: BOUNDARY_LINE,
        type: 'line',
        source: BOUNDARY_SOURCE,
        paint: { 'line-color': '#24e3c6', 'line-width': 2, 'line-opacity': 0.7 },
      });
      setLoaded(true);
    });

    const markers = markersRef.current;
    return () => {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      map.remove();
      mapRef.current = null;
      centeredRef.current = false;
      setLoaded(false);
    };
    // Intentionally run once: initial center is a best-effort seed and later
    // props are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snap to the player the first time we learn where they are.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || centeredRef.current) return;
    const focus = self ?? boundary?.center;
    if (!focus) return;
    centeredRef.current = true;
    map.easeTo({ center: [focus.lng, focus.lat], zoom: PLAY_ZOOM, duration: 600 });
  }, [self, boundary]);

  // Keep the boundary overlay in sync with the source of truth.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource(BOUNDARY_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(boundary ? boundaryFeature(boundary) : EMPTY_DATA);
  }, [boundary, loaded]);

  // Reconcile one marker per visible player: the caller's own pin plus every
  // other permitted position. Markers absent from the latest set are removed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;

    const desired = new Map<string, { lngLat: LngLat; kind: 'self' | 'other' }>();
    if (self) desired.set('self', { lngLat: self, kind: 'self' });
    for (const [id, pos] of Object.entries(others)) {
      if (id === selfId) continue; // own pin comes from the live GPS fix, not the fan-out
      desired.set(id, { lngLat: { lng: pos.lng, lat: pos.lat }, kind: 'other' });
    }

    for (const [id, marker] of markers) {
      if (!desired.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }

    for (const [id, { lngLat, kind }] of desired) {
      const existing = markers.get(id);
      if (existing) {
        existing.setLngLat([lngLat.lng, lngLat.lat]);
      } else {
        const marker = new maplibregl.Marker({ element: makePin(kind) })
          .setLngLat([lngLat.lng, lngLat.lat])
          .addTo(map);
        markers.set(id, marker);
      }
    }
  }, [self, selfId, others]);

  return <div ref={containerRef} className="game-map" data-testid="game-map" />;
}
