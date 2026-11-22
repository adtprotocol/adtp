/**
 * The database seam. The node speaks to one of two databases through this
 * interface:
 *
 *   sqlite    the default: a single file next to the keys, nothing to set up
 *   postgres  for operators who outgrow that: set database_url to postgres://...
 *
 * SQL is written once, in the dialect both share, with $1-style parameters.
 * Each driver returns rows in the same shape: timestamps as Date, JSON columns
 * parsed, booleans as booleans.
 */
import type { Logger } from '../log.js';

export type Dialect = 'sqlite' | 'postgres';

export interface QueryResult<Row> {
  rows: Row[];
  /** Rows returned, or rows changed for statements that return none. */
  rowCount: number;
}

/** Anything that can run a statement: the database, or a transaction on it. */
export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

export interface Db extends Queryable {
  readonly dialect: Dialect;
  /** Where the data lives, for the startup banner. Never includes credentials. */
  readonly location: string;
  /** Runs `fn` in one transaction. Inside it, use the handle passed in, not the Db. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Applies every migration that has not run yet. Returns the ones it applied. */
  migrate(log: Logger): Promise<string[]>;
  /** Resolves once the database accepts queries (a Postgres server may still be starting). */
  waitUntilReady(log: Logger): Promise<void>;
  close(): Promise<void>;
}
