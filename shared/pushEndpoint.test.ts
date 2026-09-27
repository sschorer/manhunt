import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint, PUSH_SERVICE_HOSTS } from './pushEndpoint.ts';

describe('isPushServiceEndpoint', () => {
  it.each([
    ['Chrome and Android', 'https://fcm.googleapis.com/fcm/send/abc123'],
    ['Firefox', 'https://updates.push.services.mozilla.com/wpush/v2/abc123'],
    ['Safari and iOS', 'https://web.push.apple.com/abc123'],
    ['Edge', 'https://wns2-by3p.notify.windows.com/w/?token=abc123'],
  ])('accepts the endpoint of a push service we know: %s', (_label, endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(true);
  });

  it.each([
    ['not a URL at all', 'not-a-url'],
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a non-default port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
    ['userinfo, which can hide the real host', 'https://fcm.googleapis.com@evil.example/abc'],
    ['an IPv4 literal', 'https://169.254.169.254/latest/meta-data'],
    ['an IPv6 literal', 'https://[::1]/abc'],
    ['a single-label host', 'https://push/abc'],
    ['localhost', 'https://localhost/abc'],
    ['a .localhost name', 'https://push.localhost/abc'],
    ['an mDNS name', 'https://printer.local/abc'],
    ['an internal name', 'https://metadata.internal/abc'],
    ['a home network name', 'https://router.home.arpa/abc'],
    ['a push service we do not know', 'https://push.example.com/abc'],
    ['a host that only ends in a known one', 'https://evil-fcm.googleapis.com.evil.example/abc'],
    ['the bare suffix of a wildcard entry', 'https://push.services.mozilla.com/abc'],
  ])('rejects %s', (_label, endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(false);
  });

  it('names the four push services browsers subscribe to', () => {
    expect(PUSH_SERVICE_HOSTS).toEqual([
      'fcm.googleapis.com',
      '*.push.services.mozilla.com',
      '*.push.apple.com',
      '*.notify.windows.com',
    ]);
  });
});
