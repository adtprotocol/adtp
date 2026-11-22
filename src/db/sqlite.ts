/**
 * SQLite driver, on Node's built-in `node:sqlite`. No dependency, no server.
 *
 * SQLite stores text, numbers and blobs. To hand back the same row shapes as
 * the Postgres driver, columns are declared with the type names JSON,
 * TIMESTAMP and BOOLEAN in migrations/sqlite, and results are decoded by those
 * declared types. Timestamps are stored as ISO 8601 UTC strings, which sort
 * and compare correctly as text.
 *
 * One connection, one process. Statements run synchronously, but the code
 * that issues them is async, so a queue keeps another caller's statement from
 * landing in the middle of an open transaction.
 */
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Logger } from '../log.js';
import { loadMigrations, migrationFailure } from './migrations.js';
import type { Db, Queryable, QueryResult } from './types.js';

/**
 * Loads node:sqlite. Node 22 marks the module experimental and prints a
 * one-line warning the first time it is loaded; that would greet every start
 * of every node, so that single warning is filtered out here. The choice and
 * its trade-off are recorded in DECISIONS.md.
 */
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite is an experimental feature')) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

type Decoder = (value: unknown) => unknown;

const DECODERS: Record<string, Decoder> = {
  JSON: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
  TIMESTAMP: (v) => (typeof v === 'string' ? new Date(v) : v),
  BOOLEAN: (v) => (v === null ? null : v === 1 || v === 1n || v === true),
};

interface Prepared {
  statement: StatementSync;
  /** True when the statement produces rows (SELECT, or anything with RETURNING). */
  returnsRows: boolean;
  /** Per result column: its name and how to decode it, for columns that need decoding. */
  decode: [string, Decoder][];
}

const MAX_CACHED_STATEMENTS = 300;

function encode(value: unknown): string | number | bigint | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  readonly location: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Prepared>();
  private queue: Promise<unknown> = Promise.resolve();

  /** `file` is a path, or ":memory:" for a database that lives and dies with the process. */
  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
      // The file holds message contents: owner-only, like the keyring. SQLite gives its
      // -wal and -shm companions the same permissions as the main file.
      closeSync(openSync(file, 'a', 0o600));
      chmodSync(file, 0o600);
    }
    this.location = file === ':memory:' ? 'SQLite (in memory)' : `SQLite file ${path.resolve(file)}`;
    this.db = new (loadSqlite().DatabaseSync)(file);
    // WAL: readers never block the writer, and a crash cannot leave a half-written file.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  private prepare(sql: string): Prepared {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    // The shared SQL uses $1, $2, ...; SQLite's numbered form is ?1, ?2, ...
    const statement = this.db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    const columns = statement.columns();
    const prepared: Prepared = {
      statement,
      returnsRows: columns.length > 0,
      decode: columns.flatMap((c): [string, Decoder][] => {
        const decoder = c.type ? DECODERS[c.type.toUpperCase()] : undefined;
        return decoder ? [[c.name, decoder]] : [];
      }),
    };
    if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear();
    this.statements.set(sql, prepared);
    return prepared;
  }

  private run<Row>(sql: string, params: unknown[] = []): QueryResult<Row> {
    const prepared = this.prepare(sql);
    const values = params.map(encode);
    if (!prepared.returnsRows) {
      return { rows: [], rowCount: Number(prepared.statement.run(...values).changes) };
    }
    const rows = prepared.statement.all(...values) as Record<string, unknown>[];
    for (const row of rows) {
      for (const [column, decoder] of prepared.decode) row[column] = decoder(row[column]);
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }

  /** Runs `task` after everything already queued, whether or not those succeeded. */
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> {
    return this.enqueue(() => this.run<Row>(sql, params));
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn({ query: async (sql, params) => this.run(sql, params) });
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  migrate(log: Logger): Promise<string[]> {
    return this.enqueue(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL)');
      const done = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version));
      const migrations = loadMigrations('sqlite');
      const applied: string[] = [];
      for (const { version, sql } of migrations) {
        if (done.has(version)) continue;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)').run(version, new Date().toISOString());
          this.db.exec('COMMIT');
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw migrationFailure(version, err as Error, done, migrations.map((m) => m.version));
        }
        this.statements.clear(); // the schema changed under any cached statement
        applied.push(version);
        log.info('applied migration', { version, database: 'sqlite' });
      }
      return applied;
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.query('SELECT 1');
  }

  close(): Promise<void> {
    return this.enqueue(() => {
      this.statements.clear();
      this.db.close();
    });
  }
}
