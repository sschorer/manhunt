import { useEffect, useRef, useState } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { boundaryFeature, type BoundaryCircle, type LngLat } from './geo.ts';
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
const ALERT_SOURCE = 'alert';
const ALERT_FILL = 'alert-fill';
const ALERT_LINE = 'alert-line';
const REVEAL_SOURCE = 'reveal';
const REVEAL_LINE = 'reveal-line';

/** Zoom the map opens at once a position is known — street level for a chase. */
const PLAY_ZOOM = 15;

/** Empty feature collection used to clear a source. */
const EMPTY_DATA = { type: 'FeatureCollection' as const, features: [] };

/** Which side a marker belongs to — drives its colour (red hunters, teal hiders). */
export type MarkerTeam = 'hunter' | 'hider';

/**
 * How a marker is drawn: the player's own glowing pin (`self`), another live
 * player (`player`), or a hider's ageing last-known position on a hunter's map
 * (`ghost` — dashed, with a "last seen" caption).
 */
export type MarkerKind = 'self' | 'player' | 'ghost';

/** One pin to place on the map. */
export interface MapMarker {
  /** Stable id used to reconcile the marker across renders (usually a player id). */
  id: string;
  lngLat: LngLat;
  team: MarkerTeam;
  kind: MarkerKind;
  /** Optional caption under the pin, e.g. `"last seen 2m"` for a ghost. */
  label?: string;
}

export interface GameMapProps {
  /** Every pin to draw this render — own position, live opponents, ghosts. */
  markers: MapMarker[];
  /** The point to recentre on the first time it's known (the player's own fix). */
  focus: LngLat | null;
  /** The play-area boundary to overlay, or `null` before one is known. */
  boundary: BoundaryCircle | null;
  /** A proximity-alert ring to draw around the player (hunter view), or `null`. */
  alertRing?: BoundaryCircle | null;
  /** A reveal-radius ring to draw around the player (hider view), or `null`. */
  revealRing?: BoundaryCircle | null;
  /**
   * Dim the map to signal the fixes are last-known, not live — set while the
   * socket is dropped so a hunter/hider doesn't mistake a frozen position for a
   * fresh one (BACKLOG.md #24).
   */
  stale?: boolean;
}

/** Build (or refresh) the DOM element MapLibre uses for a marker. */
function syncPin(el: HTMLElement, marker: MapMarker): void {
  el.className = `map-pin map-pin--${marker.kind} map-pin--${marker.team}`;
  const label = marker.label ?? '';
  let caption = el.querySelector<HTMLSpanElement>('.map-pin__label');
  if (!label) {
    caption?.remove();
    return;
  }
  if (!caption) {
    caption = document.createElement('span');
    caption.className = 'map-pin__label';
    el.appendChild(caption);
  }
  caption.textContent = label;
}

function makePin(marker: MapMarker): HTMLElement {
  const el = document.createElement('div');
  syncPin(el, marker);
  return el;
}

/**
 * The live match map: a MapLibre GL map that overlays the play-area boundary,
 * optional proximity/reveal rings, and one pin per {@link MapMarker} the caller
 * decides to show — the player's own glowing position, live opponents, and (on a
 * hunter's map) each hider's ageing last-known "ghost". The map is created once
 * and then imperatively kept in sync as the props change; React only owns the
 * container element. The caller (`ActiveGame`) resolves roles and visibility;
 * this component just draws what it is handed.
 */
export default function GameMap({
  markers,
  focus,
  boundary,
  alertRing = null,
  revealRing = null,
  stale = false,
}: GameMapProps) {
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

    const center = focus ?? boundary?.center ?? { lng: 0, lat: 0 };
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [center.lng, center.lat],
      zoom: focus || boundary ? PLAY_ZOOM : 1,
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

      // Hunter proximity-alert ring: a faint red disc around the player.
      map.addSource(ALERT_SOURCE, { type: 'geojson', data: EMPTY_DATA });
      map.addLayer({
        id: ALERT_FILL,
        type: 'fill',
        source: ALERT_SOURCE,
        paint: { 'fill-color': '#ff4242', 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: ALERT_LINE,
        type: 'line',
        source: ALERT_SOURCE,
        paint: { 'line-color': '#ff4242', 'line-width': 1.5, 'line-opacity': 0.5 },
      });

      // Hider reveal ring: a dashed amber circle marking the exposure radius.
      map.addSource(REVEAL_SOURCE, { type: 'geojson', data: EMPTY_DATA });
      map.addLayer({
        id: REVEAL_LINE,
        type: 'line',
        source: REVEAL_SOURCE,
        paint: {
          'line-color': '#e0b341',
          'line-width': 1.5,
          'line-opacity': 0.8,
          'line-dasharray': [3, 3],
        },
      });

      setLoaded(true);
    });

    const markerStore = markersRef.current;
    return () => {
      for (const marker of markerStore.values()) marker.remove();
      markerStore.clear();
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
    const target = focus ?? boundary?.center;
    if (!target) return;
    centeredRef.current = true;
    map.easeTo({ center: [target.lng, target.lat], zoom: PLAY_ZOOM, duration: 600 });
  }, [focus, boundary]);

  // Keep each circular overlay in sync with its source of truth.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const apply = (id: string, circle: BoundaryCircle | null): void => {
      const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      source?.setData(circle ? boundaryFeature(circle) : EMPTY_DATA);
    };
    apply(BOUNDARY_SOURCE, boundary);
    apply(ALERT_SOURCE, alertRing);
    apply(REVEAL_SOURCE, revealRing);
  }, [boundary, alertRing, revealRing, loaded]);

  // Reconcile one MapLibre marker per {@link MapMarker}: create newcomers, move
  // and restyle survivors in place, and remove any that are gone this render.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const store = markersRef.current;
    const desired = new Map(markers.map((m) => [m.id, m]));

    for (const [id, marker] of store) {
      if (!desired.has(id)) {
        marker.remove();
        store.delete(id);
      }
    }

    for (const [id, marker] of desired) {
      const existing = store.get(id);
      if (existing) {
        existing.setLngLat([marker.lngLat.lng, marker.lngLat.lat]);
        syncPin(existing.getElement(), marker);
      } else {
        const created = new maplibregl.Marker({ element: makePin(marker) })
          .setLngLat([marker.lngLat.lng, marker.lngLat.lat])
          .addTo(map);
        store.set(id, created);
      }
    }
  }, [markers]);

  return (
    <div
      ref={containerRef}
      className={`game-map${stale ? ' game-map--stale' : ''}`}
      data-testid="game-map"
    />
  );
}
