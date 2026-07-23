/**
 * The account store (BACKLOG.md #20): account records, credential checks, and the
 * vouch (web-of-trust) graph. It is the durable side of the auth subsystem —
 * accounts and trust outlive any single game — so unlike the lobby/live stores
 * the production implementation is PostgreSQL-backed ({@link createPostgresAccountStore}
 * in `./postgres.ts`).
 *
 * The interface is storage-agnostic so tests (and a bare dev checkout without a
 * database) can drive the whole auth surface against {@link createMemoryAccountStore},
 * exactly as the lobby/live/subscription stores are injected into `createServer`.
 *
 * ## Trust
 *
 * An account is **trusted** when it is reachable from a *root* account by
 * following `voucher → vouchee` edges: a root vouches for A, A vouches for B, and
 * both A and B are trusted. A vouch by an untrusted account records an edge but
 * confers nothing until the voucher itself becomes reachable from a root — so the
 * seeded root is the sole trust anchor and the graph can't be bootstrapped from
 * the outside.
 */
import { hashPassword, verifyPassword } from './password.ts';

/** A public account record. Never carries the password hash. */
export interface Account {
  id: string;
  name: string;
  /** Normalized sign-in handle, or `null` for a credential-less/imported row. */
  username: string | null;
  isRoot: boolean;
  createdAt: string;
}

/** Fields for creating an account. `password` is hashed before storage. */
export interface NewAccount {
  name: string;
  username: string;
  password: string;
  /** Seed a root (trust anchor). Only the bootstrap path sets this. */
  isRoot?: boolean;
}

/** Error codes surfaced to the client so it can show a specific message. */
export type AuthErrorCode =
  | 'name_required'
  | 'username_required'
  | 'password_required'
  | 'username_taken'
  | 'account_not_found'
  | 'self_vouch';

/** A recoverable auth-operation failure, translated to an HTTP error response. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** The durable account + trust store. */
export interface AccountStore {
  /**
   * Create an account, hashing its password. Throws {@link AuthError} on a blank
   * field (`name_required`/`username_required`/`password_required`) or a
   * duplicate handle (`username_taken`). The username is normalized first.
   */
  createAccount(input: NewAccount): Promise<Account>;
  /** Look up by id, or `null` if unknown. */
  getById(id: string): Promise<Account | null>;
  /** Look up by (normalized) username, or `null` if unknown. */
  getByUsername(username: string): Promise<Account | null>;
  /**
   * Verify a username + password pair, returning the account on success or `null`
   * on an unknown user, a credential-less account, or a wrong password. The work
   * is constant-ish either way — a real hash is compared even for an unknown user
   * is not required here, but callers should not leak which half failed.
   */
  verifyCredentials(username: string, password: string): Promise<Account | null>;
  /**
   * Record that `voucherId` vouches for `voucheeId`. Idempotent (a repeat is a
   * no-op). Throws {@link AuthError} `self_vouch` when the two are equal, or
   * `account_not_found` when either id is unknown.
   */
  vouch(voucherId: string, voucheeId: string): Promise<void>;
  /**
   * Whether `accountId` is trusted: it is a root, or reachable from some root by
   * following vouch edges. Unknown ids are not trusted.
   */
  isTrusted(accountId: string): Promise<boolean>;
  /** Whether any root account exists (drives {@link bootstrapRoot}). */
  hasRoot(): Promise<boolean>;
}

/** Longest accepted display name — mirrors the lobby's roster bound. */
export const MAX_NAME_LENGTH = 24;
/** Longest accepted username, to bound the handle and keep sign-in tidy. */
export const MAX_USERNAME_LENGTH = 32;

/**
 * Normalize a username to its canonical, comparable form: trimmed and
 * lower-cased, so `Alice`, `alice`, and ` alice ` are one handle. The stored and
 * looked-up value is always this form.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Validate + normalize the fields of a new account, or throw {@link AuthError}. */
function normalizeNewAccount(input: NewAccount): {
  name: string;
  username: string;
  password: string;
  isRoot: boolean;
} {
  const name = input.name?.trim() ?? '';
  if (name === '') throw new AuthError('name_required', 'A display name is required');
  const username = normalizeUsername(input.username ?? '');
  if (username === '') throw new AuthError('username_required', 'A username is required');
  if (!input.password) throw new AuthError('password_required', 'A password is required');
  return {
    name: name.slice(0, MAX_NAME_LENGTH),
    username: username.slice(0, MAX_USERNAME_LENGTH),
    password: input.password,
    isRoot: input.isRoot ?? false,
  };
}

// Shared by the memory store and (indirectly, via the same validation) the
// Postgres store's create path, so both reject the same blank/oversized input.
export { normalizeNewAccount };

/** One stored account, with the hash the public {@link Account} never exposes. */
interface StoredAccount extends Account {
  passwordHash: string;
}

/** Strip the hash to hand back a public {@link Account}. */
function toPublic(row: StoredAccount): Account {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    isRoot: row.isRoot,
    createdAt: row.createdAt,
  };
}

/**
 * An in-memory {@link AccountStore} for tests and bare dev checkouts. Trust is
 * computed by a breadth-first walk of the vouch edges out from every root, so it
 * always reflects the current graph with no cached-staleness to manage.
 */
export function createMemoryAccountStore(): AccountStore {
  const byId = new Map<string, StoredAccount>();
  const byUsername = new Map<string, StoredAccount>();
  // voucher id -> set of vouchee ids.
  const edges = new Map<string, Set<string>>();
  let counter = 0;

  const trusted = (rootSeed: StoredAccount[]): Set<string> => {
    const reached = new Set<string>();
    const queue: string[] = [];
    for (const root of rootSeed) {
      if (!reached.has(root.id)) {
        reached.add(root.id);
        queue.push(root.id);
      }
    }
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const vouchee of edges.get(current) ?? []) {
        if (!reached.has(vouchee)) {
          reached.add(vouchee);
          queue.push(vouchee);
        }
      }
    }
    return reached;
  };

  return {
    async createAccount(input) {
      const { name, username, password, isRoot } = normalizeNewAccount(input);
      if (byUsername.has(username)) {
        throw new AuthError('username_taken', 'That username is taken');
      }
      const row: StoredAccount = {
        id: `acct-${++counter}`,
        name,
        username,
        isRoot,
        createdAt: new Date().toISOString(),
        passwordHash: await hashPassword(password),
      };
      byId.set(row.id, row);
      byUsername.set(username, row);
      return toPublic(row);
    },

    async getById(id) {
      const row = byId.get(id);
      return row ? toPublic(row) : null;
    },

    async getByUsername(username) {
      const row = byUsername.get(normalizeUsername(username));
      return row ? toPublic(row) : null;
    },

    async verifyCredentials(username, password) {
      const row = byUsername.get(normalizeUsername(username));
      if (!row || !row.passwordHash) return null;
      const ok = await verifyPassword(password, row.passwordHash);
      return ok ? toPublic(row) : null;
    },

    async vouch(voucherId, voucheeId) {
      if (voucherId === voucheeId) {
        throw new AuthError('self_vouch', 'An account cannot vouch for itself');
      }
      if (!byId.has(voucherId) || !byId.has(voucheeId)) {
        throw new AuthError('account_not_found', 'No such account');
      }
      let set = edges.get(voucherId);
      if (!set) {
        set = new Set();
        edges.set(voucherId, set);
      }
      set.add(voucheeId);
    },

    async isTrusted(accountId) {
      if (!byId.has(accountId)) return false;
      const roots = [...byId.values()].filter((a) => a.isRoot);
      return trusted(roots).has(accountId);
    },

    async hasRoot() {
      for (const row of byId.values()) if (row.isRoot) return true;
      return false;
    },
  };
}
