import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * One process, one file, synchronous access. The synchronous driver is the whole
 * point: a transaction on a subject cannot interleave with another, so the
 * serialisation the ledger needs falls out of the storage engine rather than
 * being reconstructed with locks (docs/plan/credits-mvp.md §2).
 */
export function openDb(path = ':memory:'): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const applied = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  if (applied !== undefined) return;
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('version', '1');
}

/** better-sqlite3 returns unknown rows; this keeps the casts in one place. */
export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(db: Db, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}
