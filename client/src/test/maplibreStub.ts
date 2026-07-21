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
  on(event: string, cb: () => void) {
    if (event === 'load') cb();
    return this;
  }
  addSource() {}
  addLayer() {}
  getSource() {
    return { setData: () => {} };
  }
  easeTo() {}
  remove() {}
}

class FakeMarker {
  setLngLat() {
    return this;
  }
  addTo() {
    return this;
  }
  remove() {}
}

export default { Map: FakeMap, Marker: FakeMarker };
