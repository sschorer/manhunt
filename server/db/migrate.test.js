import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMigrations, runMigrations, MIGRATIONS_DIR } from './migrate.js';

/**
 * An in-memory stand-in for a `pg` client. It records every statement, tracks
 * the applied migration ids so `runMigrations` behaves idempotently, and lets
 * a test force a specific statement to throw.
 */
function fakeClient({ failOn } = {}) {
  const applied = new Set();
  const statements = [];
  return {
    statements,
    applied,
    async query(sql, params) {
      statements.push(sql.trim());
      if (failOn && sql.includes(failOn)) {
        throw new Error(`boom: ${failOn}`);
      }
      if (/^select id from schema_migrations/i.test(sql.trim())) {
        return { rows: [...applied].map((id) => ({ id })) };
      }
      if (/insert into schema_migrations/i.test(sql)) {
        applied.add(Number(params[0]));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function tmpMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manhunt-mig-'));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return dir;
}

describe('readMigrations', () => {
  it('parses and orders the real migration files', () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]).toMatchObject({ id: 1, filename: '0001_init.sql' });
    // Ids strictly ascending.
    const ids = migrations.map((m) => m.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('rejects a badly named migration file', () => {
    const dir = tmpMigrations({ 'init.sql': 'select 1;' });
    expect(() => readMigrations(dir)).toThrow(/expected NNNN_name\.sql/);
  });

  it('rejects duplicate migration ids', () => {
    const dir = tmpMigrations({
      '0001_a.sql': 'select 1;',
      '0001_b.sql': 'select 2;',
    });
    expect(() => readMigrations(dir)).toThrow(/Duplicate migration id 1/);
  });
});

describe('runMigrations', () => {
  const dir = tmpMigrations({
    '0001_a.sql': 'create table a (id int);',
    '0002_b.sql': 'create table b (id int);',
  });

  it('applies pending migrations in a transaction and records them', async () => {
    const client = fakeClient();
    const ran = await runMigrations({ client, dir, logger: { log() {} } });

    expect(ran.map((m) => m.id)).toEqual([1, 2]);
    expect(client.statements).toContain('create table a (id int);');
    expect(client.statements.filter((s) => s === 'begin')).toHaveLength(2);
    expect(client.statements.filter((s) => s === 'commit')).toHaveLength(2);
    expect(client.statements).not.toContain('rollback');
  });

  it('is idempotent — a second run applies nothing', async () => {
    const client = fakeClient();
    await runMigrations({ client, dir, logger: { log() {} } });
    const again = await runMigrations({ client, dir, logger: { log() {} } });
    expect(again).toEqual([]);
  });

  it('rolls back and does not record a failing migration', async () => {
    const client = fakeClient({ failOn: 'create table b' });
    await expect(
      runMigrations({ client, dir, logger: { log() {} } }),
    ).rejects.toThrow(/0002_b\.sql failed/);

    expect(client.statements).toContain('rollback');
    // First migration committed, the failed one was not recorded.
    expect(client.applied.has(1)).toBe(true);
    expect(client.applied.has(2)).toBe(false);
  });
});

describe('MIGRATIONS_DIR', () => {
  it('points at db/migrations containing the initial migration', () => {
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, '0001_init.sql'))).toBe(true);
  });
});
