import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool, closePool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the checked-in migration files. */
export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

/**
 * Read and validate the migration files in `dir`.
 *
 * Migrations are `NNNN_name.sql` files applied in ascending numeric order. The
 * numeric prefix is the migration id and must be unique. Returns the parsed
 * migrations sorted by id.
 */
export function readMigrations(dir = MIGRATIONS_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const migrations = [];
  const seen = new Map();

  for (const filename of files) {
    const match = /^(\d+)_.+\.sql$/.exec(filename);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${filename}" — expected NNNN_name.sql`,
      );
    }
    const id = Number(match[1]);
    if (seen.has(id)) {
      throw new Error(
        `Duplicate migration id ${id}: "${seen.get(id)}" and "${filename}"`,
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
async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      id         integer primary key,
      filename   text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function getAppliedIds(client) {
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
 * @returns {Promise<Array<{id:number, filename:string}>>} migrations applied now
 */
export async function runMigrations({
  client,
  dir = MIGRATIONS_DIR,
  logger = console,
} = {}) {
  const migrations = readMigrations(dir);
  await ensureMigrationsTable(client);
  const applied = await getAppliedIds(client);

  const ran = [];
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
      throw new Error(
        `migration ${migration.filename} failed: ${err.message}`,
        { cause: err },
      );
    }
    ran.push({ id: migration.id, filename: migration.filename });
  }

  return ran;
}

/**
 * Connect to the database (via the shared pool) and apply pending migrations.
 * This is the entry point used by the CLI and by the server on boot.
 */
export async function migrate({ dir = MIGRATIONS_DIR, logger = console } = {}) {
  const client = await getPool().connect();
  try {
    const ran = await runMigrations({ client, dir, logger });
    if (ran.length === 0) {
      logger.log?.('migrations: already up to date');
    } else {
      logger.log?.(`migrations: applied ${ran.length}`);
    }
    return ran;
  } finally {
    client.release();
  }
}

// Run as a CLI: `node server/db/migrate.js` (or `npm run db:migrate`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(err.message);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
