import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import GameMap, { type MapMarker } from './GameMap.tsx';
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
    getElement() {
      return this.element;
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
  it('creates a map and installs the boundary + ring layers', () => {
    render(<GameMap markers={[]} focus={null} boundary={null} />);
    expect(state.maps).toHaveLength(1);
    expect(state.maps[0]!.layers).toEqual(
      expect.arrayContaining(['boundary-fill', 'boundary-line', 'alert-line', 'reveal-line']),
    );
  });

  it('overlays the play-area boundary as a polygon', () => {
    render(<GameMap markers={[]} focus={null} boundary={boundary} />);
    const data = state.maps[0]!.sourceData['boundary'] as {
      geometry?: { type?: string };
    };
    expect(data.geometry?.type).toBe('Polygon');
  });

  it('draws the alert and reveal rings when supplied', () => {
    render(
      <GameMap
        markers={[]}
        focus={{ lng: 4.9, lat: 52.37 }}
        boundary={null}
        alertRing={boundary}
        revealRing={boundary}
      />,
    );
    const map = state.maps[0]!;
    expect((map.sourceData['alert'] as { geometry?: { type?: string } }).geometry?.type).toBe(
      'Polygon',
    );
    expect((map.sourceData['reveal'] as { geometry?: { type?: string } }).geometry?.type).toBe(
      'Polygon',
    );
  });

  it('draws a pin per marker, styled by kind and team', () => {
    const markers: MapMarker[] = [
      { id: 'me', lngLat: { lng: 4.9, lat: 52.37 }, team: 'hunter', kind: 'self' },
      { id: 'p2', lngLat: { lng: 4.91, lat: 52.38 }, team: 'hunter', kind: 'player' },
      {
        id: 'h1',
        lngLat: { lng: 4.92, lat: 52.39 },
        team: 'hider',
        kind: 'ghost',
        label: 'last seen 2m',
      },
    ];
    render(<GameMap markers={markers} focus={{ lng: 4.9, lat: 52.37 }} boundary={boundary} />);

    const pins = liveMarkers();
    expect(pins).toHaveLength(3);
    expect(pins.filter((p) => p.element.className.includes('map-pin--self'))).toHaveLength(1);
    expect(pins.filter((p) => p.element.className.includes('map-pin--player'))).toHaveLength(1);
    const ghost = pins.find((p) => p.element.className.includes('map-pin--ghost'));
    expect(ghost?.element.querySelector('.map-pin__label')?.textContent).toBe('last seen 2m');
  });

  it('renders with no markers yet', () => {
    render(<GameMap markers={[]} focus={null} boundary={null} />);
    expect(liveMarkers()).toHaveLength(0);
    expect(state.maps).toHaveLength(1);
  });
});
