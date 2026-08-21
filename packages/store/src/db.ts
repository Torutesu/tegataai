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

/**
 * Statements are compiled once and reused. Preparing on every call costs about four
 * times as much as running a cached one, and on the authorize path — which runs six
 * statements per request — that is most of the budget.
 */
const cache = new WeakMap<Db, Map<string, Database.Statement>>();

export function stmt(db: Db, sql: string): Database.Statement {
  let byDb = cache.get(db);
  if (byDb === undefined) { byDb = new Map(); cache.set(db, byDb); }
  let prepared = byDb.get(sql);
  if (prepared === undefined) { prepared = db.prepare(sql); byDb.set(sql, prepared); }
  return prepared;
}

/** better-sqlite3 returns unknown rows; this keeps the casts in one place. */
export function all<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return stmt(db, sql).all(...(params as never[])) as T[];
}

export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return stmt(db, sql).get(...(params as never[])) as T | undefined;
}

export function run(db: Db, sql: string, ...params: unknown[]): void {
  stmt(db, sql).run(...(params as never[]));
}
