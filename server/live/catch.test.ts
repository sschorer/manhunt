import { describe, expect, it } from 'vitest';
import { DEFAULT_CATCH_RADIUS_M, evaluateCatch } from './catch.ts';
import type { Position } from './positions.ts';

/** A hider's fix at Amsterdam's Dam square, the anchor for the distance tests. */
const target: Position = { lat: 52.3731, lng: 4.8922, recordedAt: '2026-07-22T12:00:00.000Z' };

/**
 * A position due north of `from` by roughly `meters`. One degree of latitude is
 * ~111.32 km, precise enough to place a hunter a known distance from the hider.
 */
function northOf(from: { lat: number; lng: number }, meters: number): Position {
  return { lat: from.lat + meters / 111_320, lng: from.lng, recordedAt: '2026-07-22T12:00:05.000Z' };
}

describe('evaluateCatch', () => {
  it('accepts a hunter within the catch radius of a hider', () => {
    const decision = evaluateCatch({
      hunterRole: 'hunter',
      targetRole: 'hider',
      hunterPosition: northOf(target, 5),
      targetPosition: target,
      radiusM: DEFAULT_CATCH_RADIUS_M,
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('expected the catch to be accepted');
    expect(decision.distanceM).toBeGreaterThan(0);
    expect(decision.distanceM).toBeLessThanOrEqual(DEFAULT_CATCH_RADIUS_M);
  });

  it('accepts a hunter standing exactly on the hider', () => {
    const decision = evaluateCatch({
      hunterRole: 'hunter',
      targetRole: 'hider',
      hunterPosition: target,
      targetPosition: target,
      radiusM: DEFAULT_CATCH_RADIUS_M,
    });
    expect(decision.ok).toBe(true);
  });

  it('rejects a hunter beyond the catch radius, reporting the distance', () => {
    const decision = evaluateCatch({
      hunterRole: 'hunter',
      targetRole: 'hider',
      hunterPosition: northOf(target, 50),
      targetPosition: target,
      radiusM: DEFAULT_CATCH_RADIUS_M,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('expected an out-of-range rejection');
    expect(decision.reason).toBe('out_of_range');
    expect(decision.distanceM).toBeGreaterThan(DEFAULT_CATCH_RADIUS_M);
  });

  it('rejects a claimant who is not a hunter', () => {
    const decision = evaluateCatch({
      hunterRole: 'hider',
      targetRole: 'hider',
      hunterPosition: target,
      targetPosition: target,
      radiusM: DEFAULT_CATCH_RADIUS_M,
    });
    expect(decision).toEqual({ ok: false, reason: 'not_hunter' });
  });

  it('rejects a target who is not a hider (already a hunter / caught)', () => {
    const decision = evaluateCatch({
      hunterRole: 'hunter',
      targetRole: 'hunter',
      hunterPosition: target,
      targetPosition: target,
      radiusM: DEFAULT_CATCH_RADIUS_M,
    });
    expect(decision).toEqual({ ok: false, reason: 'not_hider' });
  });

  it('rejects when a position is missing for either player', () => {
    expect(
      evaluateCatch({
        hunterRole: 'hunter',
        targetRole: 'hider',
        hunterPosition: undefined,
        targetPosition: target,
        radiusM: DEFAULT_CATCH_RADIUS_M,
      }),
    ).toEqual({ ok: false, reason: 'no_position' });

    expect(
      evaluateCatch({
        hunterRole: 'hunter',
        targetRole: 'hider',
        hunterPosition: target,
        targetPosition: undefined,
        radiusM: DEFAULT_CATCH_RADIUS_M,
      }),
    ).toEqual({ ok: false, reason: 'no_position' });
  });

  it('checks roles before positions so an ineligible claim never needs a fix', () => {
    // A non-hunter with no positions at all is still rejected on the role, not
    // on a missing fix — the role gate short-circuits first.
    const decision = evaluateCatch({
      hunterRole: undefined,
      targetRole: 'hider',
      hunterPosition: undefined,
      targetPosition: undefined,
      radiusM: DEFAULT_CATCH_RADIUS_M,
    });
    expect(decision).toEqual({ ok: false, reason: 'not_hunter' });
  });

  it('honours a custom radius', () => {
    const claim = {
      hunterRole: 'hunter' as const,
      targetRole: 'hider' as const,
      hunterPosition: northOf(target, 30),
      targetPosition: target,
    };
    // 30 m apart: out of range at 15 m, in range at 100 m.
    expect(evaluateCatch({ ...claim, radiusM: 15 }).ok).toBe(false);
    expect(evaluateCatch({ ...claim, radiusM: 100 }).ok).toBe(true);
  });
});
