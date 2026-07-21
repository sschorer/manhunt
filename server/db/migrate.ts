import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool, closePool } from './pool.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the checked-in migration files. */
export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

/** A migration file discovered on disk. */
export interface Migration {
  id: number;
  filename: string;
  sql: string;
}

/** A migration applied during a run. */
export interface AppliedMigration {
  id: number;
  filename: string;
}

/**
 * The subset of a `pg` client used by the runner. Kept minimal so a fake client
 * can drive `runMigrations` in tests without a live database.
 */
export interface Queryable {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface Logger {
  log?: (message: string) => void;
}

interface RunOptions {
  client: Queryable;
  dir?: string;
  logger?: Logger;
}

interface MigrateOptions {
  dir?: string;
  logger?: Logger;
}

/**
 * Fixed key for the session-level advisory lock that serializes migrators, so
 * concurrent processes (multiple replicas booting with `RUN_MIGRATIONS=true`,
 * or `db:migrate` racing a boot) can't both apply the same migration.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4_927_632_198;

/**
 * Read and validate the migration files in `dir`.
 *
 * Migrations are `NNNN_name.sql` files applied in ascending numeric order. The
 * numeric prefix is the migration id and must be unique. Returns the parsed
 * migrations sorted by id.
 */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const migrations: Migration[] = [];
  const seen = new Map<number, string>();

  for (const filename of files) {
    const match = /^(\d+)_.+\.sql$/.exec(filename);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${filename}" — expected NNNN_name.sql`,
      );
    }
    const id = Number(match[1]);
    const existing = seen.get(id);
    if (existing) {
      throw new Error(
        `Duplicate migration id ${id}: "${existing}" and "${filename}"`,
      );
    }
    seen.set(id, filename);
    migrations.push({
      id,
      filename,
      sql: fs.readFileSync(path.join(dir, filename), 'utf8'),
    });
  }

  return migrations.sort((a, b) => a.id - b.id);
}

/** Create the bookkeeping table that records which migrations have run. */
async function ensureMigrationsTable(client: Queryable): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      id         integer primary key,
      filename   text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedIds(client: Queryable): Promise<Set<number>> {
  const { rows } = await client.query('select id from schema_migrations');
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * Apply any pending migrations using the provided `client`.
 *
 * Each migration runs in its own transaction: on failure the transaction is
 * rolled back and the error is rethrown, so a partially-applied migration never
 * gets recorded. Already-applied migrations (tracked in `schema_migrations`)
 * are skipped, making this safe to run repeatedly and on boot.
 *
 * Kept separate from pool/connection handling so it can be driven by a fake
 * client in tests without a live database.
 *
 * @returns the migrations applied during this run
 */
export async function runMigrations({
  client,
  dir = MIGRATIONS_DIR,
  logger = console,
}: RunOptions): Promise<AppliedMigration[]> {
  const migrations = readMigrations(dir);
  await ensureMigrationsTable(client);
  const applied = await getAppliedIds(client);

  const ran: AppliedMigration[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    logger.log?.(`applying migration ${migration.filename}`);
    try {
      await client.query('begin');
      await client.query(migration.sql);
      await client.query(
        'insert into schema_migrations (id, filename) values ($1, $2)',
        [migration.id, migration.filename],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${migration.filename} failed: ${reason}`, {
        cause: err,
      });
    }
    ran.push({ id: migration.id, filename: migration.filename });
  }

  return ran;
}

/**
 * Connect to the database (via the shared pool) and apply pending migrations.
 * This is the entry point used by the CLI and by the server on boot.
 */
export async function migrate({
  dir = MIGRATIONS_DIR,
  logger = console,
}: MigrateOptions = {}): Promise<AppliedMigration[]> {
  const client = await getPool().connect();
  try {
    // Take a cross-process lock so only one migrator applies at a time; other
    // processes block here and then find everything already applied. Released
    // explicitly below (advisory locks outlive a pool checkout otherwise).
    await client.query('select pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      const ran = await runMigrations({ client, dir, logger });
      if (ran.length === 0) {
        logger.log?.('migrations: already up to date');
      } else {
        logger.log?.(`migrations: applied ${ran.length}`);
      }
      return ran;
    } finally {
      await client
        .query('select pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    client.release();
  }
}

// Run as a CLI: `node server/db/migrate.ts` (or `npm run db:migrate`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      await closePool().catch(() => {});
      process.exit(1);
    });
}
