import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_MIGRATIONS_DIR } from './driver.js'

/**
 * Migration runner.
 *
 * Migrations are plain `.sql` files named `NNN_name.sql`, applied in filename
 * order, each inside its own transaction. There is no down migration: rolling a
 * schema backwards is a decision with data attached to it, and SQLite cannot do
 * it safely. The recovery path is a restore from the backup the launcher takes
 * before migrating, which is why `reset.js` exists.
 *
 * Each applied file is recorded with a checksum. If a file that has already run
 * later changes, that is not a migration, it is an edited history, and the
 * runner refuses rather than leaving two machines with the same version number
 * and different schemas.
 */

const MIGRATION_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    id          TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    statements  INTEGER NOT NULL DEFAULT 0,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    duration_ms INTEGER NOT NULL DEFAULT 0
  )
`

export function ensureLedger(db) {
  db.exec(CREATE_LEDGER)
}

/** Reads and validates the migrations directory. Throws on gaps or duplicates. */
export function readMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`)
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const migrations = []
  const seen = new Map()

  for (const file of files) {
    const match = MIGRATION_PATTERN.exec(file)
    if (!match) {
      throw new Error(
        `Migration "${file}" does not follow the NNN_name.sql naming convention.`,
      )
    }
    const id = file.slice(0, file.length - 4)
    if (seen.has(match[1])) {
      throw new Error(
        `Duplicate migration number ${match[1]}: "${seen.get(match[1])}" and "${file}".`,
      )
    }
    seen.set(match[1], file)

    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    migrations.push({
      id,
      file,
      path: path.join(dir, file),
      sql,
      checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex'),
    })
  }

  return migrations
}

export function appliedMigrations(db) {
  ensureLedger(db)
  const rows = db.prepare('SELECT id, checksum FROM schema_migration').all()
  return new Map(rows.map((row) => [row.id, row.checksum]))
}

/**
 * Verifies that every migration already recorded still matches its file, and
 * that no migration was applied out of order relative to the files on disk.
 */
function assertHistoryIntact(migrations, applied) {
  const ids = migrations.map((migration) => migration.id)

  for (const [id, checksum] of applied) {
    const index = ids.indexOf(id)
    if (index === -1) {
      throw new Error(
        `Database has migration "${id}" applied, but that file is missing from the ` +
          'migrations directory. Restore the file or reset the database.',
      )
    }
    const migration = migrations[index]
    if (migration.checksum !== checksum) {
      throw new Error(
        `Migration "${id}" has changed since it was applied. Migrations are immutable: ` +
          'add a new migration instead, or reset the database to rebuild from scratch.',
      )
    }
  }

  // The applied set must be a prefix of the files on disk. A hole means an
  // earlier migration was skipped, and continuing would produce a schema that
  // matches no version anybody has tested.
  const firstPending = ids.findIndex((id) => !applied.has(id))
  const appliedAfterPending = ids.slice(Math.max(firstPending, 0)).filter((id) => applied.has(id))
  if (firstPending !== -1 && appliedAfterPending.length > 0) {
    throw new Error(
      'Migrations were applied out of order (' +
        `${appliedAfterPending.join(', ')} applied after a pending migration). ` +
        'Reset the database to rebuild the schema.',
    )
  }
}

function countStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.replace(/--[^\n]*/g, '').trim())
    .filter((statement) => statement.length > 0).length
}

/**
 * Applies every pending migration.
 *
 * `onProgress` is called once per migration so `scripts/migrate.js` can print
 * what happened; a silent migration run is indistinguishable from a failed one.
 */
export function migrate(db, options = {}) {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR
  const onProgress = options.onProgress ?? (() => {})

  ensureLedger(db)

  const migrations = readMigrations(dir)
  const applied = appliedMigrations(db)
  assertHistoryIntact(migrations, applied)

  const record = db.prepare(
    `INSERT INTO schema_migration (id, checksum, statements, duration_ms)
     VALUES (@id, @checksum, @statements, @duration_ms)`,
  )

  const results = []
  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      results.push({ id: migration.id, status: 'skipped' })
      onProgress({ ...migration, status: 'skipped' })
      continue
    }

    const startedAt = process.hrtime.bigint()
    // Each migration is atomic on its own. A migration with a syntax error half
    // way through leaves the database exactly as it was.
    const apply = db.transaction(() => {
      db.exec(migration.sql)
      record.run({
        id: migration.id,
        checksum: migration.checksum,
        statements: countStatements(migration.sql),
        duration_ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
      })
    })
    apply()

    results.push({ id: migration.id, status: 'applied' })
    onProgress({ ...migration, status: 'applied' })
  }

  return results
}

export function migrationStatus(db, options = {}) {
  ensureLedger(db)
  const applied = appliedMigrations(db)
  return readMigrations(options.dir ?? DEFAULT_MIGRATIONS_DIR).map((migration) => ({
    id: migration.id,
    status: applied.has(migration.id) ? 'applied' : 'pending',
  }))
}
