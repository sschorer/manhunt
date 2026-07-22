import { describe, expect, it } from 'vitest';
import { mergeSightings, nearest, type Sightings } from './proximity.ts';
import type { LivePositions } from './useLivePositions.ts';

const self = { lng: 4.9, lat: 52.37 };

describe('nearest', () => {
  it('returns null without an own fix', () => {
    expect(nearest(null, { p2: { lng: 4.9, lat: 52.38, recordedAt: 'x' } })).toBeNull();
  });

  it('returns null when there is no one to measure against', () => {
    expect(nearest(self, {})).toBeNull();
  });

  it('picks the closest of several and names the direction', () => {
    const others: LivePositions = {
      far: { lng: 4.95, lat: 52.37, recordedAt: 'x' },
      near: { lng: 4.9, lat: 52.371, recordedAt: 'x' }, // just north
    };
    const result = nearest(self, others);
    expect(result?.id).toBe('near');
    expect(result?.direction).toBe('north');
    expect(result?.distanceM).toBeLessThan(150);
  });
});

describe('mergeSightings', () => {
  it('records newly-visible hiders', () => {
    const visible: LivePositions = { h1: { lng: 4.9, lat: 52.37, recordedAt: 't1' } };
    const merged = mergeSightings({}, visible);
    expect(merged.h1).toEqual(visible.h1);
  });

  it('keeps a hider that dropped out of the current set', () => {
    const prev: Sightings = { h1: { lng: 4.9, lat: 52.37, recordedAt: 't1' } };
    // A later non-reveal tick has no hiders visible; the last sighting persists.
    expect(mergeSightings(prev, {})).toBe(prev);
  });

  it('updates a hider when a newer fix arrives', () => {
    const prev: Sightings = { h1: { lng: 4.9, lat: 52.37, recordedAt: 't1' } };
    const merged = mergeSightings(prev, { h1: { lng: 4.91, lat: 52.38, recordedAt: 't2' } });
    expect(merged).not.toBe(prev);
    expect(merged.h1?.recordedAt).toBe('t2');
  });

  it('returns the same reference when nothing changed', () => {
    const prev: Sightings = { h1: { lng: 4.9, lat: 52.37, recordedAt: 't1' } };
    expect(mergeSightings(prev, { h1: { lng: 4.9, lat: 52.37, recordedAt: 't1' } })).toBe(prev);
  });
});
