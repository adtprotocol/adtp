import { PostgresDb, type PostgresOptions } from './postgres.js';
import { SqliteDb } from './sqlite.js';
import type { Db, Dialect } from './types.js';

export type { Db, Dialect, Queryable, QueryResult } from './types.js';

/** Which database a database_url selects, or null if it is neither. */
export function dialectOf(url: string): Dialect | null {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres';
  if (/^sqlite:/i.test(url)) return 'sqlite';
  return null;
}

/** The file a sqlite: URL names. Accepts sqlite:relative/path, sqlite:/abs/path, sqlite:///abs/path and sqlite::memory: */
export function sqlitePath(url: string): string {
  const rest = url.replace(/^sqlite:/i, '');
  return rest.startsWith('//') ? rest.slice(2) : rest;
}

/**
 * Opens the database a URL names:
 *   sqlite:<path>          a SQLite file (the default the config produces)
 *   postgres://...         a Postgres server
 */
export function openDatabase(url: string, opts: PostgresOptions = {}): Db {
  const dialect = dialectOf(url);
  if (dialect === 'postgres') return new PostgresDb(url, opts);
  if (dialect === 'sqlite') return new SqliteDb(sqlitePath(url));
  throw new Error('database_url must be sqlite:<path> or postgres://user:password@host/database');
}
