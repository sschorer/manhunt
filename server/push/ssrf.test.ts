import { describe, expect, it } from 'vitest';
import { embeddedIpv4, guardedLookup, isPrivateIp, isPrivateIpv4 } from './ssrf.ts';

describe('isPrivateIpv4', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
  ])('flags a private/reserved address: %s', (ip) => {
    expect(isPrivateIpv4(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1'])(
    'allows a public address: %s',
    (ip) => {
      expect(isPrivateIpv4(ip)).toBe(false);
    },
  );

  it('is false for a non-IPv4 string', () => {
    expect(isPrivateIpv4('example.com')).toBe(false);
  });
});

describe('embeddedIpv4', () => {
  it('unwraps an IPv4-mapped IPv6 in dotted form', () => {
    expect(embeddedIpv4('::ffff:169.254.169.254')).toBe('169.254.169.254');
  });

  it('unwraps an IPv4-mapped IPv6 in hex form (the URL/DNS-normalized shape)', () => {
    expect(embeddedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
  });

  it('unwraps a NAT64 literal', () => {
    expect(embeddedIpv4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254');
  });

  it('returns undefined for an IPv6 with no embedded IPv4', () => {
    expect(embeddedIpv4('::1')).toBeUndefined();
    expect(embeddedIpv4('fe80::1')).toBeUndefined();
  });
});

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '192.168.0.1',
    '169.254.169.254',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '[::ffff:169.254.169.254]',
    '64:ff9b::a9fe:a9fe',
  ])('flags a private/reserved IP: %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '2606:4700:4700::1111', 'fe00::1'])('allows a public IP: %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it('is false for a plain hostname', () => {
    expect(isPrivateIp('fcm.googleapis.com')).toBe(false);
  });
});

describe('guardedLookup', () => {
  it('blocks a hostname that resolves to loopback (localhost)', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup('localhost', { all: true }, (e) => resolve(e));
    });
    expect(err).toBeTruthy();
    expect(err?.code).toBe('EBLOCKEDADDR');
  });
});
