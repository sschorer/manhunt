import { describe, expect, it } from 'vitest';
import { createPostgresAccountStore } from './postgres.ts';
import { hashPassword } from './password.ts';
import { AuthError } from './store.ts';
import type { Queryable } from '../db/migrate.ts';

/** A pg error carries a SQLSTATE `code`; fake one to exercise the translations. */
function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

interface Call {
  sql: string;
  params?: unknown[];
}

/**
 * A scriptable `Queryable` stand-in: match incoming SQL by substring to a handler
 * that returns rows (or throws), recording every call for assertions.
 */
function fakeDb(
  handlers: Array<{ match: string; rows?: Array<Record<string, unknown>>; throws?: Error }>,
): Queryable & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      const handler = handlers.find((h) => sql.includes(h.match));
      if (!handler) throw new Error(`unexpected SQL: ${sql}`);
      if (handler.throws) throw handler.throws;
      return { rows: handler.rows ?? [] };
    },
  };
}

describe('postgres account store', () => {
  const row = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Alice',
    username: 'alice',
    is_root: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };

  it('creates an account, normalizing input and mapping the row', async () => {
    const db = fakeDb([{ match: 'insert into accounts', rows: [row] }]);
    const store = createPostgresAccountStore(db);
    const account = await store.createAccount({ name: '  Alice ', username: '  ALICE ', password: 'pw' });

    expect(account).toEqual({
      id: row.id,
      name: 'Alice',
      username: 'alice',
      isRoot: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const insert = db.calls[0];
    expect(insert?.params?.[0]).toBe('Alice'); // trimmed name
    expect(insert?.params?.[1]).toBe('alice'); // normalized username
    expect(typeof insert?.params?.[2]).toBe('string'); // a hash, not the raw password
    expect(insert?.params?.[2]).not.toBe('pw');
  });

  it('translates a unique violation into username_taken', async () => {
    const db = fakeDb([{ match: 'insert into accounts', throws: pgError('23505') }]);
    const store = createPostgresAccountStore(db);
    await expect(
      store.createAccount({ name: 'A', username: 'dup', password: 'p' }),
    ).rejects.toMatchObject({ code: 'username_taken' });
  });

  it('looks accounts up by id and username', async () => {
    const db = fakeDb([{ match: 'where id = $1', rows: [row] }]);
    const store = createPostgresAccountStore(db);
    expect(await store.getById(row.id)).toMatchObject({ id: row.id });

    const empty = fakeDb([{ match: 'where username = $1', rows: [] }]);
    expect(await createPostgresAccountStore(empty).getByUsername('nobody')).toBeNull();
    expect(empty.calls[0]?.params?.[0]).toBe('nobody');
  });

  it('verifies credentials against the stored hash', async () => {
    const hash = await hashPassword('hunter2');
    const db = fakeDb([
      { match: 'password_hash from accounts', rows: [{ ...row, password_hash: hash }] },
    ]);
    const store = createPostgresAccountStore(db);
    expect(await store.verifyCredentials('alice', 'hunter2')).toMatchObject({ id: row.id });
    expect(await store.verifyCredentials('alice', 'wrong')).toBeNull();
  });

  it('returns null credentials when the account or hash is missing', async () => {
    const noRow = createPostgresAccountStore(
      fakeDb([{ match: 'password_hash from accounts', rows: [] }]),
    );
    expect(await noRow.verifyCredentials('ghost', 'x')).toBeNull();

    const noHash = createPostgresAccountStore(
      fakeDb([{ match: 'password_hash from accounts', rows: [{ ...row, password_hash: null }] }]),
    );
    expect(await noHash.verifyCredentials('alice', 'x')).toBeNull();
  });

  it('records a vouch and rejects self / unknown accounts', async () => {
    const ok = fakeDb([{ match: 'insert into vouches', rows: [] }]);
    const store = createPostgresAccountStore(ok);
    await store.vouch('a', 'b');
    expect(ok.calls[0]?.params).toEqual(['a', 'b']);

    // Self-vouch is caught before any query.
    const untouched = fakeDb([]);
    await expect(createPostgresAccountStore(untouched).vouch('a', 'a')).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(untouched.calls).toHaveLength(0);

    const fk = createPostgresAccountStore(
      fakeDb([{ match: 'insert into vouches', throws: pgError('23503') }]),
    );
    await expect(fk.vouch('a', 'ghost')).rejects.toMatchObject({ code: 'account_not_found' });
  });

  it('reads trust and root existence as booleans', async () => {
    const trusted = createPostgresAccountStore(
      fakeDb([{ match: 'recursive trusted', rows: [{ trusted: true }] }]),
    );
    expect(await trusted.isTrusted('a')).toBe(true);

    const untrusted = createPostgresAccountStore(
      fakeDb([{ match: 'recursive trusted', rows: [{ trusted: false }] }]),
    );
    expect(await untrusted.isTrusted('a')).toBe(false);

    const hasRoot = createPostgresAccountStore(
      fakeDb([{ match: 'where is_root', rows: [{ has: true }] }]),
    );
    expect(await hasRoot.hasRoot()).toBe(true);
  });
});
