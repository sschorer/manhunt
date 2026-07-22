/**
 * An inert MapLibre GL stub for jsdom tests. jsdom has no WebGL context, so any
 * component that mounts the map (`GameMap`, and anything rendering it) needs the
 * real module replaced. Use it as a `vi.mock` factory:
 *
 * ```ts
 * vi.mock('maplibre-gl', async () => {
 *   const { default: stub } = await import('../test/maplibreStub.ts');
 *   return { default: stub };
 * });
 * ```
 *
 * Tests that need to assert on what the map was asked to do (see
 * `GameMap.test.tsx`) instrument their own stub instead of using this one.
 */
class FakeMap {
  private sources = new Map<string, { setData: () => void }>();

  on(event: string, cb: () => void) {
    if (event === 'load') cb();
    return this;
  }
  addSource(id: string) {
    this.sources.set(id, { setData: () => {} });
  }
  addLayer() {}
  getSource(id: string) {
    // Mirror MapLibre: only known sources resolve; unknown ids are undefined.
    return this.sources.get(id);
  }
  easeTo() {}
  remove() {}
}

class FakeMarker {
  private element: HTMLElement;
  constructor(opts?: { element?: HTMLElement }) {
    this.element = opts?.element ?? document.createElement('div');
  }
  setLngLat() {
    return this;
  }
  getElement() {
    return this.element;
  }
  addTo() {
    return this;
  }
  remove() {}
}

export default { Map: FakeMap, Marker: FakeMarker };
