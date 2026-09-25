#!/usr/bin/env node
/**
 * Applies pending migrations and reports the schema status.
 *
 * Run by the Pinokio launcher before every start, and by hand when something
 * looks wrong. It exits non-zero on failure, because a launcher that starts a
 * server against a half-migrated database produces errors that look like
 * application bugs.
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openDatabase, closeDatabase, DEFAULT_MIGRATIONS_DIR } from '../src/db/driver.js'
import { migrate, migrationStatus } from '../src/db/migrator.js'

const args = new Set(process.argv.slice(2))
const statusOnly = args.has('--status')
const quiet = args.has('--quiet')

function log(message) {
  if (!quiet) process.stdout.write(`${message}\n`)
}

const config = loadConfig()
const db = openDatabase(config)

try {
  if (statusOnly) {
    for (const row of migrationStatus(db)) {
      log(`${row.status === 'applied' ? '  ok ' : '  -- '} ${row.id}`)
    }
    const pending = migrationStatus(db).filter((row) => row.status === 'pending').length
    log(pending === 0 ? 'Schema is up to date.' : `${pending} migration(s) pending.`)
  } else {
    const results = migrate(db, {
      dir: DEFAULT_MIGRATIONS_DIR,
      onProgress: (migration) => {
        log(
          migration.status === 'applied'
            ? `  applied  ${migration.id}`
            : `  current  ${migration.id}`,
        )
      },
    })
    const applied = results.filter((row) => row.status === 'applied').length
    log(
      applied === 0
        ? 'Schema is up to date.'
        : `Applied ${applied} migration(s) to ${config.database.file}.`,
    )
  }
} catch (error) {
  process.stderr.write(`Migration failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  closeDatabase(db)
}
