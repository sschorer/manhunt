import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret');
    expect(await verifyPassword('S3cret', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts each hash, so identical passwords differ', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toEqual(b);
    // Both still verify against their own hash.
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('produces the self-describing scrypt format', async () => {
    const hash = await hashPassword('x');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // N, r, p are integers.
    expect(Number.isInteger(Number(parts[1]))).toBe(true);
  });

  it('fails closed on a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$1$onlyfiveparts')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$16384$8$1$abc$def')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$x$8$1$c2FsdA$aGFzaA')).toBe(false);
  });

  it('re-derives with the parameters embedded in the hash', async () => {
    // A hash written with a smaller N still verifies (params come from the string,
    // not today's default), so cost can be tuned without invalidating old hashes.
    const { scrypt } = await import('node:crypto');
    const salt = Buffer.from('sixteenbytesalt!');
    const key: Buffer = await new Promise((resolve, reject) =>
      scrypt('legacy', salt, 32, { N: 1024, r: 8, p: 1 }, (e, k) =>
        e ? reject(e) : resolve(k),
      ),
    );
    const stored = ['scrypt', 1024, 8, 1, salt.toString('base64url'), key.toString('base64url')].join(
      '$',
    );
    expect(await verifyPassword('legacy', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });
});
