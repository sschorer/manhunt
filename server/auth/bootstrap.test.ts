import { describe, expect, it, vi } from 'vitest';
import { bootstrapRoot, bootstrapRootAndLog, resolveRootConfig } from './bootstrap.ts';
import { createMemoryAccountStore } from './store.ts';

describe('resolveRootConfig', () => {
  it('defaults username/name and omits an unset password', () => {
    expect(resolveRootConfig({})).toEqual({ username: 'root', name: 'Root' });
  });

  it('reads the environment', () => {
    expect(
      resolveRootConfig({ ROOT_USERNAME: 'admin', ROOT_NAME: 'Boss', ROOT_PASSWORD: 'pw' }),
    ).toEqual({ username: 'admin', name: 'Boss', password: 'pw' });
  });
});

describe('bootstrapRoot', () => {
  it('seeds a root with a generated password when none is supplied', async () => {
    const store = createMemoryAccountStore();
    const result = await bootstrapRoot(store, { username: 'root', name: 'Root' });

    expect(result.created).toBe(true);
    expect(result.account?.isRoot).toBe(true);
    expect(result.generatedPassword).toBeTruthy();
    // The generated password actually works.
    const login = await store.verifyCredentials('root', result.generatedPassword as string);
    expect(login?.id).toBe(result.account?.id);
    expect(await store.hasRoot()).toBe(true);
  });

  it('uses a supplied password and reports no generated one', async () => {
    const store = createMemoryAccountStore();
    const result = await bootstrapRoot(store, { username: 'root', name: 'Root', password: 'set-me' });
    expect(result.created).toBe(true);
    expect(result.generatedPassword).toBeUndefined();
    expect(await store.verifyCredentials('root', 'set-me')).not.toBeNull();
  });

  it('is idempotent — a second call creates nothing', async () => {
    const store = createMemoryAccountStore();
    await bootstrapRoot(store, { username: 'root', name: 'Root', password: 'x' });
    const again = await bootstrapRoot(store, { username: 'root', name: 'Root', password: 'x' });
    expect(again).toEqual({ created: false });
  });
});

describe('bootstrapRootAndLog', () => {
  it('logs the generated password exactly once, on creation', async () => {
    const store = createMemoryAccountStore();
    const logger = { log: vi.fn(), warn: vi.fn() };
    const result = await bootstrapRootAndLog(store, { username: 'root', name: 'Root' }, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain(result.generatedPassword as string);
  });

  it('does not log a secret when the root already exists', async () => {
    const store = createMemoryAccountStore();
    await bootstrapRoot(store, { username: 'root', name: 'Root', password: 'x' });
    const logger = { log: vi.fn(), warn: vi.fn() };
    await bootstrapRootAndLog(store, { username: 'root', name: 'Root' }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith('root account "root" already exists');
  });
});
