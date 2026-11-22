import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dialect } from './types.js';

export interface Migration {
  version: string;
  sql: string;
}

/** migrations/<dialect>/ at the package root. This file compiles to dist/src/db/migrations.js. */
export function migrationsDir(dialect: Dialect): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations', dialect);
}

/** Every migration for a dialect, in filename order. */
export function loadMigrations(dialect: Dialect, dir = migrationsDir(dialect)): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ version: file, sql: readFileSync(path.join(dir, file), 'utf8') }));
}

/** v0 has no upgrade path between schema generations; say so instead of leaving a cryptic SQL error. */
export function migrationFailure(version: string, err: Error, alreadyApplied: Set<string>, known: string[]): Error {
  const stale = [...alreadyApplied].filter((v) => !known.includes(v));
  const hint =
    stale.length > 0
      ? ` This database was created by an earlier build (it has ${stale.join(', ')}). ADTP v0 does not migrate between schema generations: start with a fresh database.`
      : '';
  return new Error(`migration ${version} failed: ${err.message}.${hint}`);
}
