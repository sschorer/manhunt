import { createServer } from './app.ts';
import { migrate } from './db/migrate.ts';
import { getPool } from './db/pool.ts';
import {
  bootstrapRootAndLog,
  createMemoryAccountStore,
  createPostgresAccountStore,
  type AccountStore,
} from './auth/index.ts';

const PORT = process.env.PORT || 3000;

// Optionally apply database migrations on boot. Opt-in via RUN_MIGRATIONS=true
// so a bare dev checkout without PostgreSQL still starts; the same runner is
// available on demand via `npm run db:migrate`.
if (process.env.RUN_MIGRATIONS === 'true') {
  try {
    await migrate();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('failed to apply migrations on boot:', reason);
    process.exit(1);
  }
}

// Wire the account + trust store (BACKLOG.md #20). With a database configured we
// use the PostgreSQL-backed store and seed the root account (idempotent, so it is
// safe on every boot); without one, a bare dev checkout falls back to an
// in-process store so sign-in still works locally (accounts just aren't durable).
let accounts: AccountStore;
if (process.env.DATABASE_URL) {
  accounts = createPostgresAccountStore(getPool());
  try {
    await bootstrapRootAndLog(accounts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('failed to bootstrap root account:', reason);
    process.exit(1);
  }
} else {
  console.warn('DATABASE_URL is not set — using an in-memory account store (dev only).');
  accounts = createMemoryAccountStore();
}

const { httpServer } = createServer({ accounts });

httpServer.listen(PORT, () => console.log(`manhunt server listening on :${PORT}`));
