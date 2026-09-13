import { describe, expect, expectTypeOf, it } from 'vitest';
import { CLOSE_CODES, isCloseCode, type CloseCode } from './closeCodes.ts';
import { PROTOCOL_VERSION } from './version.ts';

describe('CLOSE_CODES', () => {
  it('maps each meaning to its application close code', () => {
    expect(CLOSE_CODES).toEqual({
      seatRejected: 4001,
      gameEnded: 4002,
      replaced: 4003,
      protocolOutdated: 4004,
    });
    expectTypeOf<CloseCode>().toEqualTypeOf<4001 | 4002 | 4003 | 4004>();
  });

  it('recognizes only its own codes', () => {
    expect([4001, 4002, 4003, 4004].every(isCloseCode)).toBe(true);
    expect(isCloseCode(1000)).toBe(false);
    expect(isCloseCode(1006)).toBe(false);
    expect(isCloseCode(4005)).toBe(false);
  });
});

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    expectTypeOf<typeof PROTOCOL_VERSION>().toEqualTypeOf<1>();
  });
});
