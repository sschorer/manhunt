import { afterEach, describe, expect, it, vi } from 'vitest';

// Stub ioredis so the module never opens a real socket. A lightweight class is
// enough — the connection module only constructs it, attaches an error handler,
// and calls quit().
vi.mock('ioredis', () => {
  class FakeRedis {
    on(): this {
      return this;
    }
    quit(): Promise<string> {
      return Promise.resolve('OK');
    }
  }
  return { Redis: FakeRedis };
});

const REDIS_URL = 'redis://localhost:6379';

describe('redis client', () => {
  const original = process.env.REDIS_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
    vi.resetModules();
  });

  it('isRedisConfigured reflects REDIS_URL', async () => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    const withoutUrl = await import('./client.ts');
    expect(withoutUrl.isRedisConfigured()).toBe(false);

    vi.resetModules();
    process.env.REDIS_URL = REDIS_URL;
    const withUrl = await import('./client.ts');
    expect(withUrl.isRedisConfigured()).toBe(true);
  });

  it('getRedis throws a clear error when REDIS_URL is unset', async () => {
    vi.resetModules();
    delete process.env.REDIS_URL;
    const mod = await import('./client.ts');
    expect(() => mod.getRedis()).toThrow(/REDIS_URL is not set/);
  });

  it('reuses one command connection and a separate subscriber connection', async () => {
    vi.resetModules();
    process.env.REDIS_URL = REDIS_URL;
    const mod = await import('./client.ts');

    const command = mod.getRedis();
    expect(mod.getRedis()).toBe(command); // reused, not reconnected

    const sub = mod.getSubscriber();
    expect(mod.getSubscriber()).toBe(sub); // reused
    expect(sub).not.toBe(command); // pub/sub needs its own connection

    await expect(mod.closeRedis()).resolves.toBeUndefined();
  });
});
