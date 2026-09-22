import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { childLogger } from '../common/logger';
import { MIGRATIONS } from './schema';

export type Db = Database.Database;

/**
 * Open the state database and bring it up to date.
 *
 * WAL mode plus `synchronous = FULL`: this file is the only record of what the
 * bot believes it owns, and a crash mid-write that loses a position record is
 * how a bot ends up holding a coin it has forgotten to sell.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const log = childLogger('migrations');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((row) => (row as { id: string }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    // Each migration is one transaction: it applies completely or not at all.
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        Date.now(),
      );
    })();
    log.info({ migration: migration.id }, 'applied migration');
  }
}
