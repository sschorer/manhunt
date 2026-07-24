/**
 * The PostgreSQL-backed {@link AccountStore} (BACKLOG.md #20) — the production
 * account + trust store, over the `accounts` and `vouches` tables from migration
 * 0002. It shares the input validation and hashing with the in-memory store so
 * both reject the same bad input and store the same self-describing scrypt
 * digests; only persistence differs.
 *
 * Trust is resolved in the database with a recursive CTE that walks vouch edges
 * out from the root(s), so a single round-trip answers "is this account
 * reachable from a root" without pulling the whole graph into the process.
 */
import { hashPassword, verifyPassword } from './password.ts';
import {
  AuthError,
  normalizeNewAccount,
  normalizeUsername,
  type Account,
  type AccountStore,
  type NewAccount,
} from './store.ts';
import type { Queryable } from '../db/migrate.ts';

/** PostgreSQL SQLSTATE codes we translate into {@link AuthError}s. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** The columns selected for a public {@link Account}, in a stable order. */
const ACCOUNT_COLUMNS = 'id, name, username, is_root, created_at';

/** Map a selected `accounts` row to a public {@link Account}. */
function toAccount(row: Record<string, unknown>): Account {
  const createdAt = row.created_at;
  return {
    id: String(row.id),
    name: String(row.name),
    username: row.username == null ? null : String(row.username),
    isRoot: Boolean(row.is_root),
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}

/** The SQLSTATE code of a `pg` error, if it carries one. */
function sqlState(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

/**
 * Build a PostgreSQL-backed {@link AccountStore} over a `Queryable` — a `pg.Pool`,
 * a pooled client, or a fake in tests. The store issues plain parameterized
 * queries and never holds a transaction across calls, so a shared pool is fine.
 */
export function createPostgresAccountStore(db: Queryable): AccountStore {
  return {
    async createAccount(input: NewAccount): Promise<Account> {
      const { name, username, password, isRoot } = normalizeNewAccount(input);
      const passwordHash = await hashPassword(password);
      try {
        const { rows } = await db.query(
          `insert into accounts (name, username, password_hash, is_root)
             values ($1, $2, $3, $4)
             returning ${ACCOUNT_COLUMNS}`,
          [name, username, passwordHash, isRoot],
        );
        return toAccount(rows[0] as Record<string, unknown>);
      } catch (err) {
        if (sqlState(err) === UNIQUE_VIOLATION) {
          throw new AuthError('username_taken', 'That username is taken');
        }
        throw err;
      }
    },

    async getById(id) {
      const { rows } = await db.query(
        `select ${ACCOUNT_COLUMNS} from accounts where id = $1`,
        [id],
      );
      return rows[0] ? toAccount(rows[0]) : null;
    },

    async getByUsername(username) {
      const { rows } = await db.query(
        `select ${ACCOUNT_COLUMNS} from accounts where username = $1`,
        [normalizeUsername(username)],
      );
      return rows[0] ? toAccount(rows[0]) : null;
    },

    async verifyCredentials(username, password) {
      const { rows } = await db.query(
        `select ${ACCOUNT_COLUMNS}, password_hash from accounts where username = $1`,
        [normalizeUsername(username)],
      );
      const row = rows[0];
      const hash = row?.password_hash;
      if (!row || typeof hash !== 'string' || hash === '') return null;
      const ok = await verifyPassword(password, hash);
      return ok ? toAccount(row) : null;
    },

    async vouch(voucherId, voucheeId) {
      if (voucherId === voucheeId) {
        throw new AuthError('self_vouch', 'An account cannot vouch for itself');
      }
      try {
        await db.query(
          `insert into vouches (voucher_id, vouchee_id) values ($1, $2)
             on conflict do nothing`,
          [voucherId, voucheeId],
        );
      } catch (err) {
        if (sqlState(err) === FOREIGN_KEY_VIOLATION) {
          throw new AuthError('account_not_found', 'No such account');
        }
        throw err;
      }
    },

    async isTrusted(accountId) {
      const { rows } = await db.query(
        `with recursive trusted as (
           select id from accounts where is_root
           union
           select v.vouchee_id from vouches v
             join trusted t on v.voucher_id = t.id
         )
         select exists(select 1 from trusted where id = $1) as trusted`,
        [accountId],
      );
      return Boolean(rows[0]?.trusted);
    },

    async hasRoot() {
      const { rows } = await db.query(
        'select exists(select 1 from accounts where is_root) as has',
      );
      return Boolean(rows[0]?.has);
    },
  };
}
