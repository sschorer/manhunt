import { describe, expect, it, vi } from 'vitest';
import { createSessionCodec, resolveSessionSecret } from './session.ts';

describe('session codec', () => {
  it('round-trips an account id', () => {
    const codec = createSessionCodec({ secret: 'test-secret' });
    const token = codec.sign('acct-1');
    expect(codec.verify(token)).toMatchObject({ accountId: 'acct-1' });
  });

  it('rejects a tampered payload', () => {
    const codec = createSessionCodec({ secret: 'test-secret' });
    const token = codec.sign('acct-1');
    const [version, body, sig] = token.split('.');
    // Swap the payload for a different account id, keep the old signature.
    const forgedBody = Buffer.from(JSON.stringify({ sub: 'acct-2', iat: 1, exp: 9_999_999_999 }))
      .toString('base64url');
    expect(codec.verify(`${version}.${forgedBody}.${sig}`)).toBeNull();
    void body;
  });

  it('rejects a token signed with a different secret', () => {
    const a = createSessionCodec({ secret: 'secret-a' });
    const b = createSessionCodec({ secret: 'secret-b' });
    expect(b.verify(a.sign('acct-1'))).toBeNull();
  });

  it('rejects an expired token', () => {
    let now = 1_000_000_000_000;
    const codec = createSessionCodec({ secret: 's', ttlSeconds: 60, now: () => now });
    const token = codec.sign('acct-1');
    expect(codec.verify(token)).not.toBeNull();
    now += 61_000; // past the 60s TTL
    expect(codec.verify(token)).toBeNull();
  });

  it('rejects malformed / missing tokens without throwing', () => {
    const codec = createSessionCodec({ secret: 's' });
    expect(codec.verify(undefined)).toBeNull();
    expect(codec.verify(null)).toBeNull();
    expect(codec.verify('')).toBeNull();
    expect(codec.verify('a.b')).toBeNull();
    expect(codec.verify('v9.body.sig')).toBeNull();
    expect(codec.verify('v1.@@@.sig')).toBeNull();
  });

  it('exposes the TTL for cookie max-age', () => {
    expect(createSessionCodec({ secret: 's', ttlSeconds: 123 }).ttlSeconds).toBe(123);
  });
});

describe('resolveSessionSecret', () => {
  it('returns an explicit secret', () => {
    expect(resolveSessionSecret('provided')).toBe('provided');
  });

  it('falls back to a random secret with a warning when unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = resolveSessionSecret(undefined);
    const b = resolveSessionSecret('');
    expect(a).toBeTruthy();
    expect(a).not.toEqual(b); // random each time
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
