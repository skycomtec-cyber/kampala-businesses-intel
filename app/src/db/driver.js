import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { config as defaultConfig } from '../config.js'

/**
 * The SQLite driver.
 *
 * This is the only file in the platform that knows the database is SQLite. Every
 * other layer talks to repositories, and the repositories talk to a prepared
 * statement, so replacing this file with a Postgres pool is the whole of the
 * migration to another engine.
 *
 * Pragmas are set here rather than per connection by the caller because they are
 * not defaults anyone should be able to forget:
 *
 *   foreign_keys  The schema leans on ON DELETE RESTRICT and CASCADE. SQLite
 *                 ships with this off, which means an unenforced schema that
 *                 behaves correctly until the first orphaned row.
 *   journal_mode  WAL, so a long gap computation does not block a search.
 *   busy_timeout  Better-sqlite3 is synchronous, so a concurrent writer gets a
 *                 SQLITE_BUSY rather than a queue unless it waits.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MIGRATIONS_DIR = path.join(HERE, 'migrations')

/**
 * FTS5 is compiled into the bundled SQLite, but "should be" is not "is", and a
 * missing FTS5 would surface as a confusing syntax error at migration time
 * rather than as the actionable message it actually is.
 */
function assertFts5Available(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(probe)')
    db.exec('DROP TABLE temp.__fts5_probe')
    return true
  } catch (cause) {
    throw new Error(
      'This SQLite build has no FTS5 module, so the search architecture cannot run. ' +
        'Install better-sqlite3 from a prebuilt binary or rebuild it with FTS5 enabled.',
      { cause },
    )
  }
}

export function openDatabase(config = defaultConfig, options = {}) {
  const file = options.file ?? config.database.file
  const readonly = Boolean(options.readonly)

  fs.mkdirSync(path.dirname(file), { recursive: true })

  const db = new Database(file, { readonly, fileMustExist: readonly })

  if (!readonly) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    // A schema change that violates a foreign key should fail loudly here rather
    // than at the first cascade that depends on it.
    db.pragma('foreign_keys = ON')
  }
  db.pragma('busy_timeout = 5000')

  assertFts5Available(db)

  return db
}

export function closeDatabase(db) {
  if (!db || !db.open) return
  try {
    // Fold the WAL back into the main database so a copied file is complete.
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // A checkpoint failure is not a reason to refuse to close.
  }
  db.close()
}
