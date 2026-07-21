import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import GameMap from './GameMap.tsx';
import type { LivePositions } from './useLivePositions.ts';
import type { BoundaryCircle } from './geo.ts';

// Instrumented MapLibre stub: jsdom has no WebGL, so we record what the
// component asks the map to do rather than render anything real. The classes
// live inside the (hoisted) mock factory; tests reach their instances via
// `state`.
interface FakeMap {
  sourceData: Record<string, unknown>;
  layers: string[];
}
interface FakeMarker {
  removed: boolean;
  element: HTMLElement;
}

const { state } = vi.hoisted(() => ({
  state: {
    maps: [] as FakeMap[],
    markers: [] as FakeMarker[],
  },
}));

vi.mock('maplibre-gl', () => {
  class FakeMarkerImpl {
    lngLat: [number, number] | null = null;
    removed = false;
    element: HTMLElement;
    constructor(opts: { element: HTMLElement }) {
      this.element = opts.element;
      state.markers.push(this);
    }
    setLngLat(v: [number, number]) {
      this.lngLat = v;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
    }
  }
  class FakeMapImpl {
    sourceData: Record<string, unknown> = {};
    layers: string[] = [];
    constructor() {
      state.maps.push(this);
    }
    on(event: string, cb: () => void) {
      if (event === 'load') cb();
      return this;
    }
    addSource(id: string, source: { data: unknown }) {
      this.sourceData[id] = source.data;
    }
    addLayer(layer: { id: string }) {
      this.layers.push(layer.id);
    }
    getSource(id: string) {
      return {
        setData: (data: unknown) => {
          this.sourceData[id] = data;
        },
      };
    }
    easeTo() {}
    remove() {}
  }
  return { default: { Map: FakeMapImpl, Marker: FakeMarkerImpl } };
});

const boundary: BoundaryCircle = { center: { lng: 4.9, lat: 52.37 }, radiusM: 500 };

beforeEach(() => {
  state.maps = [];
  state.markers = [];
});

afterEach(() => {
  cleanup();
});

/** The single live marker positions, keyed for readable assertions. */
function liveMarkers() {
  return state.markers.filter((m) => !m.removed);
}

describe('<GameMap />', () => {
  it('creates a map and installs the boundary layers', () => {
    render(<GameMap self={null} selfId={null} others={{}} boundary={null} />);
    expect(state.maps).toHaveLength(1);
    expect(state.maps[0]!.layers).toEqual(
      expect.arrayContaining(['boundary-fill', 'boundary-line']),
    );
  });

  it('overlays the play-area boundary as a polygon', () => {
    render(<GameMap self={null} selfId={null} others={{}} boundary={boundary} />);
    const data = state.maps[0]!.sourceData['boundary'] as {
      geometry?: { type?: string };
    };
    expect(data.geometry?.type).toBe('Polygon');
  });

  it('draws the own pin and every other permitted player', () => {
    const others: LivePositions = {
      me: { lat: 52.37, lng: 4.9, recordedAt: '2026-07-21T00:00:00.000Z' },
      p2: { lat: 52.38, lng: 4.91, recordedAt: '2026-07-21T00:00:00.000Z' },
    };
    render(
      <GameMap self={{ lng: 4.9, lat: 52.37 }} selfId="me" others={others} boundary={boundary} />,
    );

    const pins = liveMarkers();
    // Own pin (from the live fix) + p2; the `me` entry in `others` is dropped so
    // the player isn't drawn twice.
    expect(pins).toHaveLength(2);
    expect(pins.filter((p) => p.element.className.includes('map-pin--self'))).toHaveLength(1);
    expect(pins.filter((p) => p.element.className.includes('map-pin--other'))).toHaveLength(1);
  });

  it('renders without an own position yet', () => {
    render(<GameMap self={null} selfId="me" others={{}} boundary={null} />);
    expect(liveMarkers()).toHaveLength(0);
    expect(state.maps).toHaveLength(1);
  });
});
