import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Lazily create the shared connection pool from `DATABASE_URL`.
 *
 * The pool is created on first use so that importing this module (e.g. in the
 * server or in tests) never opens a connection or requires a database to be
 * configured. Callers that don't touch persistence pay nothing.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — cannot connect to PostgreSQL');
    }
    // A finite connect timeout so boot fails fast instead of hanging forever
    // when Postgres is unreachable (the default, 0, waits indefinitely).
    pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
    // pg.Pool emits 'error' when an idle client fails (network blip, DB
    // restart). Without a listener that would crash the process; the pool
    // already discards the bad client and creates a new one, so just log it.
    pool.on('error', (err: Error) => {
      console.error('unexpected error on idle PostgreSQL client:', err.message);
    });
  }
  return pool;
}

/** Close the shared pool, if one was created. Safe to call when unused. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
