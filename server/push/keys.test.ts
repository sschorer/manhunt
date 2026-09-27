import { vapidHeaders } from '@block65/webcrypto-web-push';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateVapidKeys, resolveVapid } from './keys.ts';

const KEYS = {
  VAPID_PUBLIC_KEY: 'BHpBQzYzXaPOH-QAcGTCOMz1CpD_wj6_Wbo1rWMcWQUcZtXQ1oNAgVu5PAaDfxhEK0aM0Et_tCBYnRvJw0ntkoc',
  VAPID_PRIVATE_KEY: '1B_lBqCO7bGxD9_9k_eV5xkQsFV0bCrTFLLJnfN7Lcw',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveVapid', () => {
  it('turns both keys and a real subject into the configuration', () => {
    expect(resolveVapid({ ...KEYS, VAPID_SUBJECT: ' mailto:ada@example.com ' })).toEqual({
      publicKey: KEYS.VAPID_PUBLIC_KEY,
      privateKey: KEYS.VAPID_PRIVATE_KEY,
      subject: 'mailto:ada@example.com',
    });
  });

  it('accepts an https contact page as the subject', () => {
    expect(resolveVapid({ ...KEYS, VAPID_SUBJECT: 'https://manhunt.example/contact' })?.subject).toBe(
      'https://manhunt.example/contact',
    );
  });

  it.each([
    ['nothing configured at all', {}],
    ['only the public key', { VAPID_PUBLIC_KEY: KEYS.VAPID_PUBLIC_KEY, VAPID_SUBJECT: 'mailto:ada@example.com' }],
    ['only the private key', { VAPID_PRIVATE_KEY: KEYS.VAPID_PRIVATE_KEY, VAPID_SUBJECT: 'mailto:ada@example.com' }],
    // workerd binds a variable the operator didn't set to null.
    ['keys bound to null', { VAPID_PUBLIC_KEY: null, VAPID_PRIVATE_KEY: null, VAPID_SUBJECT: 'mailto:ada@example.com' }],
    ['a blank key', { ...KEYS, VAPID_PUBLIC_KEY: '   ', VAPID_SUBJECT: 'mailto:ada@example.com' }],
  ])('leaves push off with %s, without a warning', (_label, vars) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveVapid(vars)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['no subject', undefined],
    ['a blank subject', '  '],
    ['a subject that is neither mailto: nor https:', 'ada@example.com'],
  ])('leaves push off with keys but %s, and says so', (_label, subject) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveVapid({ ...KEYS, VAPID_SUBJECT: subject })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('vapid_subject_missing');
  });

  it('never logs a key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    resolveVapid({ ...KEYS });

    expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEYS.VAPID_PRIVATE_KEY);
  });
});

describe('generateVapidKeys', () => {
  it('generates a pair the push protocol can sign with', async () => {
    const keys = await generateVapidKeys();

    // The library is the reader of these strings: it imports the private key as
    // the JWK `d` and puts the public key in the `Authorization` header verbatim.
    const { headers } = await vapidHeaders(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } },
      { ...keys, subject: 'mailto:ada@example.com' },
    );
    expect(headers.authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  });

  it('generates base64url keys of the sizes the protocol expects', async () => {
    const { publicKey, privateKey } = await generateVapidKeys();

    expect(publicKey).toMatch(/^[\w-]+$/);
    expect(privateKey).toMatch(/^[\w-]+$/);
    // An uncompressed P-256 point: the 0x04 prefix and two 32-byte coordinates.
    expect(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/'))).toHaveLength(65);
    expect(atob(`${privateKey.replace(/-/g, '+').replace(/_/g, '/')}=`)).toHaveLength(32);
  });

  it('generates a different pair every time', async () => {
    const [first, second] = await Promise.all([generateVapidKeys(), generateVapidKeys()]);

    expect(first.publicKey).not.toBe(second.publicKey);
  });
});
