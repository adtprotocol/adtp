/** Postgres driver, on node-postgres. For nodes that have outgrown a single SQLite file. */
import pg from 'pg';
import type { Logger } from '../log.js';
import { loadMigrations, migrationFailure } from './migrations.js';
import type { Db, Queryable, QueryResult } from './types.js';

// node-postgres already parses timestamptz into Date and json into objects; keep bigint counts as numbers.
pg.types.setTypeParser(20, (v) => Number(v));

export interface PostgresOptions {
  /** Postgres schema to use instead of `public` (used by tests for isolation). */
  schema?: string;
  max?: number;
}

const MIGRATION_LOCK = 4_127_001;

async function run<Row>(target: pg.Pool | pg.PoolClient, sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
  const res = await target.query(sql, params);
  return { rows: res.rows as Row[], rowCount: res.rowCount ?? res.rows.length };
}

export class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  readonly location: string;
  private readonly pool: pg.Pool;

  constructor(url: string, opts: PostgresOptions = {}) {
    const config: pg.PoolConfig = { connectionString: url, max: opts.max ?? 10 };
    if (opts.schema) config.options = `-c search_path=${opts.schema}`;
    this.pool = new pg.Pool(config);
    // Idle clients can error when Postgres restarts; without a handler that would crash the process.
    this.pool.on('error', () => {});
    let where = 'Postgres';
    try {
      const parsed = new URL(url);
      where = `Postgres at ${parsed.host}${parsed.pathname}`;
    } catch {
      /* an unusual connection string: say nothing more than "Postgres" */
    }
    this.location = where;
  }

  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> {
    return run<Row>(this.pool, sql, params);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ query: (sql, params) => run(client, sql, params) });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Each migration runs in its own transaction, under an advisory lock so two starting nodes do not race. */
  async migrate(log: Logger): Promise<string[]> {
    const migrations = loadMigrations('postgres');
    const applied: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL)');
      const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
      for (const { version, sql } of migrations) {
        if (done.has(version)) continue;
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [version, new Date()]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw migrationFailure(version, err as Error, done, migrations.map((m) => m.version));
        }
        applied.push(version);
        log.info('applied migration', { version, database: 'postgres' });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      client.release();
    }
    return applied;
  }

  async waitUntilReady(log: Logger, attempts = 30, delayMs = 1000): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await this.pool.query('SELECT 1');
        return;
      } catch (err) {
        if (i >= attempts) throw new Error(`database is not reachable: ${(err as Error).message}`);
        log.info('waiting for database', { attempt: i });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
