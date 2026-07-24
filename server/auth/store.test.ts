import { describe, expect, it } from 'vitest';
import { AuthError, createMemoryAccountStore, normalizeUsername } from './store.ts';

describe('normalizeUsername', () => {
  it('trims and lower-cases', () => {
    expect(normalizeUsername('  Alice ')).toBe('alice');
    expect(normalizeUsername('BOB')).toBe('bob');
  });
});

describe('memory account store', () => {
  it('creates an account and looks it up, never exposing the hash', async () => {
    const store = createMemoryAccountStore();
    const account = await store.createAccount({ name: 'Alice', username: 'Alice', password: 'pw' });
    expect(account).toMatchObject({ name: 'Alice', username: 'alice', isRoot: false });
    expect(account).not.toHaveProperty('passwordHash');
    expect(account).not.toHaveProperty('password_hash');

    expect(await store.getById(account.id)).toMatchObject({ id: account.id });
    // Lookup is by normalized handle.
    expect(await store.getByUsername('  ALICE ')).toMatchObject({ id: account.id });
    expect(await store.getByUsername('nobody')).toBeNull();
  });

  it('rejects blank fields and duplicate usernames', async () => {
    const store = createMemoryAccountStore();
    await expect(store.createAccount({ name: '', username: 'u', password: 'p' })).rejects.toThrow(
      AuthError,
    );
    await expect(store.createAccount({ name: 'n', username: '', password: 'p' })).rejects.toThrow(
      /username/,
    );
    await expect(store.createAccount({ name: 'n', username: 'u', password: '' })).rejects.toThrow(
      /password/,
    );

    await store.createAccount({ name: 'A', username: 'dup', password: 'p' });
    await expect(
      store.createAccount({ name: 'B', username: 'DUP', password: 'p' }),
    ).rejects.toMatchObject({ code: 'username_taken' });
  });

  it('verifies credentials', async () => {
    const store = createMemoryAccountStore();
    await store.createAccount({ name: 'Alice', username: 'alice', password: 'hunter2' });
    expect(await store.verifyCredentials('alice', 'hunter2')).toMatchObject({ username: 'alice' });
    expect(await store.verifyCredentials('ALICE', 'hunter2')).toMatchObject({ username: 'alice' });
    expect(await store.verifyCredentials('alice', 'wrong')).toBeNull();
    expect(await store.verifyCredentials('ghost', 'whatever')).toBeNull();
  });

  it('reports whether a root exists', async () => {
    const store = createMemoryAccountStore();
    expect(await store.hasRoot()).toBe(false);
    await store.createAccount({ name: 'A', username: 'a', password: 'p' });
    expect(await store.hasRoot()).toBe(false);
    await store.createAccount({ name: 'Root', username: 'root', password: 'p', isRoot: true });
    expect(await store.hasRoot()).toBe(true);
  });

  describe('vouch / trust', () => {
    it('flows trust transitively out from the root', async () => {
      const store = createMemoryAccountStore();
      const root = await store.createAccount({ name: 'Root', username: 'root', password: 'p', isRoot: true });
      const a = await store.createAccount({ name: 'A', username: 'a', password: 'p' });
      const b = await store.createAccount({ name: 'B', username: 'b', password: 'p' });

      // Root is trusted by virtue of being root; others are not yet.
      expect(await store.isTrusted(root.id)).toBe(true);
      expect(await store.isTrusted(a.id)).toBe(false);

      await store.vouch(root.id, a.id);
      await store.vouch(a.id, b.id);
      expect(await store.isTrusted(a.id)).toBe(true);
      expect(await store.isTrusted(b.id)).toBe(true); // transitive
    });

    it('confers nothing from an untrusted voucher', async () => {
      const store = createMemoryAccountStore();
      await store.createAccount({ name: 'Root', username: 'root', password: 'p', isRoot: true });
      const a = await store.createAccount({ name: 'A', username: 'a', password: 'p' });
      const b = await store.createAccount({ name: 'B', username: 'b', password: 'p' });

      // A (untrusted) vouches for B — edge recorded, but B stays untrusted until A
      // is itself reachable from the root.
      await store.vouch(a.id, b.id);
      expect(await store.isTrusted(b.id)).toBe(false);
    });

    it('is idempotent and rejects self- and unknown-account vouches', async () => {
      const store = createMemoryAccountStore();
      const root = await store.createAccount({ name: 'Root', username: 'root', password: 'p', isRoot: true });
      const a = await store.createAccount({ name: 'A', username: 'a', password: 'p' });

      await store.vouch(root.id, a.id);
      await store.vouch(root.id, a.id); // no throw, no double edge
      expect(await store.isTrusted(a.id)).toBe(true);

      await expect(store.vouch(root.id, root.id)).rejects.toMatchObject({ code: 'self_vouch' });
      await expect(store.vouch(root.id, 'ghost')).rejects.toMatchObject({
        code: 'account_not_found',
      });
    });

    it('does not trust an unknown account id', async () => {
      const store = createMemoryAccountStore();
      await store.createAccount({ name: 'Root', username: 'root', password: 'p', isRoot: true });
      expect(await store.isTrusted('ghost')).toBe(false);
    });
  });
});
