import pg from 'pg';

const { Pool } = pg;

let pool;

/**
 * Lazily create the shared connection pool from `DATABASE_URL`.
 *
 * The pool is created on first use so that importing this module (e.g. in the
 * server or in tests) never opens a connection or requires a database to be
 * configured. Callers that don't touch persistence pay nothing.
 */
export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — cannot connect to PostgreSQL');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

/** Close the shared pool, if one was created. Safe to call when unused. */
export async function closePool() {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
