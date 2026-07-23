import { describe, expect, it } from 'vitest';
import { DEFAULT_VAPID_SUBJECT, resolveVapidConfig } from './vapid.ts';

describe('resolveVapidConfig', () => {
  it('returns the config when both keys are set', () => {
    const config = resolveVapidConfig({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:ops@example.com',
    });
    expect(config).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' });
  });

  it('accepts an https subject', () => {
    const config = resolveVapidConfig({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'https://manhunt.example.com',
    });
    expect(config?.subject).toBe('https://manhunt.example.com');
  });

  it('falls back to the default subject when unset', () => {
    const config = resolveVapidConfig({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
    expect(config?.subject).toBe(DEFAULT_VAPID_SUBJECT);
  });

  it('ignores a subject that is neither mailto: nor https:', () => {
    const config = resolveVapidConfig({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'ops@example.com',
    });
    expect(config?.subject).toBe(DEFAULT_VAPID_SUBJECT);
  });

  it('is disabled (undefined) when either key is missing', () => {
    expect(resolveVapidConfig({ VAPID_PUBLIC_KEY: 'pub' })).toBeUndefined();
    expect(resolveVapidConfig({ VAPID_PRIVATE_KEY: 'priv' })).toBeUndefined();
    expect(resolveVapidConfig({})).toBeUndefined();
  });

  it('treats blank/whitespace keys as unset', () => {
    expect(
      resolveVapidConfig({ VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: 'priv' }),
    ).toBeUndefined();
    expect(
      resolveVapidConfig({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: '' }),
    ).toBeUndefined();
  });

  it('trims surrounding whitespace from the keys', () => {
    const config = resolveVapidConfig({ VAPID_PUBLIC_KEY: '  pub\n', VAPID_PRIVATE_KEY: '\tpriv ' });
    expect(config).toMatchObject({ publicKey: 'pub', privateKey: 'priv' });
  });
});
