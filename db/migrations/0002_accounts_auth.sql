-- 0002_accounts_auth: account sign-in + the vouch (web-of-trust) graph
-- (BACKLOG.md #20, docs/arc42.md §5 "Auth / accounts").
--
-- The initial schema (0001) gave `accounts` an id, name and `is_root` flag but
-- no way to actually sign in. This adds the credentials a session is minted
-- from, and the `vouches` edges that make trust flow out from the seeded root
-- account: an account is trusted when it is reachable from a root by following
-- voucher → vouchee edges.

-- Credentials. `username` is the sign-in handle (stored already normalized —
-- trimmed + lower-cased — by the server), unique across accounts; `password_hash`
-- is a self-describing scrypt digest (see server/auth/password.ts). Both are
-- nullable so a pre-existing/imported account row without credentials stays
-- valid; an account can only sign in once both are set.
alter table accounts add column if not exists username      text unique;
alter table accounts add column if not exists password_hash text;

-- The web of trust. One row per directed vouch: `voucher_id` vouches for
-- `vouchee_id`. Self-vouches are meaningless (an account can't bootstrap its own
-- trust) and are rejected. A pair is unique — vouching twice is idempotent — so
-- the composite primary key doubles as the dedupe guard.
create table if not exists vouches (
  voucher_id uuid not null references accounts(id),
  vouchee_id uuid not null references accounts(id),
  created_at timestamptz not null default now(),
  primary key (voucher_id, vouchee_id),
  check (voucher_id <> vouchee_id)
);

-- Trust is computed by walking vouch edges out from the root(s), so the hot
-- lookup is "who did X vouch for" — index the voucher side for that traversal.
create index if not exists vouches_vouchee_id_idx on vouches (vouchee_id);
