import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'

/**
 * Backup and restore for the SQLite file.
 *
 * WHY THIS IS NOT `cp kampala.db backups/kampala.db`
 *
 * The database runs in WAL mode (`driver.js`), which means recent writes live in
 * `kampala.db-wal` until a checkpoint folds them into the main file. A copy of the
 * main file alone is therefore a copy of the database *as of the last checkpoint*,
 * which is routinely minutes or hours old, and it is silently truncated: nothing
 * about the copied file says it is missing the last few writes. The `-wal` and
 * `-shm` siblings have to travel with it, and a backup that is only the main file
 * looks exactly like a complete one.
 *
 * Worse, copying a live WAL database by reading the file while another process is
 * writing to it is not atomic. The copy can catch the main file and the WAL at
 * different moments, and the result is a database that fails its integrity check
 * - or worse, one that opens and is quietly inconsistent.
 *
 * SQLite's own online backup API is the answer to both, and it is already in the
 * driver this project depends on. `db.backup()` reads through a consistent
 * snapshot while other connections keep writing, and writes a destination that is
 * a single complete file. No sibling has to be copied, and no lock is taken that
 * would stall a search.
 *
 * So every copy in this project goes through here. The only thing a reader has to
 * remember is that `kampala.db` alone is not the database.
 *
 * WHAT IS DELIBERATELY NOT BACKED UP: the session secret
 *
 * `<dataDir>/.session-secret` is not copied, and `restore` deletes it. Restoring
 * a database onto a machine that kept its old secret would leave every session
 * cookie that was signed before the restore still valid afterwards - which is the
 * wrong direction after an incident, since the whole reason to restore is that
 * something happened. Deleting it costs one re-login per operator and buys the
 * guarantee that nobody is signed in against a database whose state they never
 * saw. The secret is generated again on the next start.
 */

/** Tables whose row counts are recorded, so a restore can be shown to have worked. */
const COUNTED_TABLES = Object.freeze([
  'schema_migration',
  'location',
  'category',
  'skill',
  'business',
  'user',
  'search_event',
  'search_query_raw',
  'demand_signal_daily',
  'gap_snapshot',
  'opportunity',
  'request',
  'audit_log',
])

/** Timestamp in filenames: sortable as text, and legal on every platform. */
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** `kampala-20261001T081500Z.db` for a given moment. */
export function backupFileName(date = new Date()) {
  return `kampala-${backupStamp(date)}.db`
}

/**
 * The manifest filename for a backup.
 *
 * Takes a basename rather than a full path on purpose. Appending to a full path
 * here looks harmless and produces an absolute path glued onto a relative one the
 * moment a caller passes one, which is how the manifest ends up named
 * `<dir>/<dir>/kampala-….db.json` and the backup looks like it has no manifest.
 */
export function manifestFileName(backupFile) {
  return `${path.basename(backupFile)}.json`
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function tableExists(db, table) {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table)
  return Boolean(row)
}

/**
 * Row counts for the tables an operator would recognise.
 *
 * A missing table counts as absent rather than as an error, so a backup taken on a
 * database that predates a migration still produces a manifest instead of failing
 * at the last step.
 */
export function countRows(db) {
  const counts = {}
  for (const table of COUNTED_TABLES) {
    if (!tableExists(db, table)) {
      counts[table] = null
      continue
    }
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  }
  return counts
}

/** Applied migration ids, so a manifest records the schema the backup was taken at. */
export function migrationIds(db) {
  if (!tableExists(db, 'schema_migration')) return []
  return db
    .prepare('SELECT id FROM schema_migration ORDER BY id')
    .all()
    .map((row) => row.id)
}

/**
 * SQLite's own integrity check, run on a file.
 *
 * This is the assertion that a backup is worth keeping. `integrity_check` walks
 * every page and every index, so it catches the truncated copy and the torn copy
 * that both look like a database file. It reports rows rather than a boolean, and
 * the first row says `ok` when there is nothing wrong.
 */
export function integrityReport(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return db.pragma('integrity_check').map((row) => Object.values(row)[0])
  } finally {
    db.close()
    // Opening a WAL database recreates a `-shm` alongside it, even read-only and
    // even when there is nothing to read. Left behind, they sit next to every
    // backup and the directory stops looking like a list of self-contained files,
    // which is the property the copy is supposed to have. A read-only connection
    // writes no pages, so removing them loses nothing.
    removeSiblings(file)
  }
}

/** Removes the `-wal` and `-shm` files, if they are there. */
function removeSiblings(file) {
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${file}${suffix}`)) fs.rmSync(`${file}${suffix}`, { force: true })
  }
}

/**
 * Copies a live database into `directory`, atomically enough to trust.
 *
 * `db.backup()` is given a temporary filename and the result is renamed into
 * place, so a destination that already exists is never half-overwritten: if this
 * process is killed mid-copy the old backup is still there and the temporary file
 * is the only casualty.
 *
 * @returns {Promise<{file: string, manifestFile: string, manifest: object}>}
 */
export async function createBackup(db, options = {}) {
  const directory = options.directory
  if (!directory) throw new Error('createBackup needs a directory to write into.')

  const date = options.date ?? new Date()
  const keep = Number.isInteger(options.keep) ? options.keep : null

  fs.mkdirSync(directory, { recursive: true })

  const file = path.join(directory, backupFileName(date))
  if (fs.existsSync(file)) {
    throw new Error(
      `A backup for ${backupStamp(date)} already exists at ${file}. ` +
        'Wait a second, or pass an explicit date.',
    )
  }

  // The destination inherits WAL from the source, so it arrives with a `-wal`
  // sibling of its own. Checkpointing and removing it is what turns the result
  // into a file that can be copied anywhere and opened with nothing beside it.
  const temporary = `${file}.partial`
  await db.backup(temporary)
  foldWalIntoMainFile(temporary)

  const manifest = {
    createdAt: date.toISOString(),
    bytes: fs.statSync(temporary).size,
    sha256: sha256(temporary),
    migrations: migrationIds(db),
    counts: countRows(db),
    // Recorded so a restore can say what the k-anonymity floor was when the data
    // was measured. A database restored under a different floor would re-apply
    // suppression to rows measured under the old one, and that is worth knowing
    // before somebody reads the restored numbers.
    kThreshold: options.kThreshold ?? null,
    // Stated in the manifest rather than left implicit, because the manifest is
    // what somebody reads six months later to decide whether this file is a
    // complete copy of the platform or just part of one.
    includesSessionSecret: false,
    tool: 'scripts/backup.js',
  }

  fs.renameSync(temporary, file)
  const manifestFile = path.join(directory, manifestFileName(file))
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const pruned = keep === null ? [] : pruneBackups(directory, keep)

  return { file, manifestFile, manifest, pruned }
}

/**
 * Folds a database file's own WAL back into it and deletes the siblings.
 *
 * `closeDatabase` in `driver.js` does this for the live database on a clean
 * shutdown, and the same two operations are all that is needed here. The
 * checkpoint is best effort for the same reason it is there: a database that
 * refuses to checkpoint is still a valid backup, and refusing to finish because
 * housekeeping failed would be the wrong way round.
 */
function foldWalIntoMainFile(file) {
  const db = new Database(file)
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // Not a reason to discard a copy that completed.
  } finally {
    db.close()
  }
  removeSiblings(file)
}

/**
 * Verifies a backup against its manifest, or on its own terms.
 *
 * The checksum is the interesting half. A file that passes `integrity_check` has
 * been proved internally consistent; it has not been proved to be the file that was
 * written. A truncated copy is internally consistent, so only the recorded hash
 * distinguishes "a good backup of something" from "this backup".
 *
 * @returns {{file: string, exists: boolean, integrity: string[], checksum: object|null, manifest: object|null}}
 */
export function verifyBackup(file) {
  if (!fs.existsSync(file)) {
    return { file, exists: false, integrity: [], checksum: null, manifest: null }
  }

  let integrity
  try {
    integrity = integrityReport(file)
  } catch (error) {
    return {
      file,
      exists: true,
      integrity: [`unreadable: ${error.message}`],
      checksum: null,
      manifest: null,
    }
  }

  const manifestPath = path.join(
    path.dirname(file),
    manifestFileName(path.basename(file)),
  )
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null

  let checksum = null
  if (manifest) {
    const actual = sha256(file)
    checksum = {
      expected: manifest.sha256,
      actual,
      matches: actual === manifest.sha256,
    }
  }

  return { file, exists: true, integrity, checksum, manifest }
}

/** Backups in `directory`, newest first. */
export function listBackups(directory) {
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith('kampala-') && name.endsWith('.db'))
    .sort()
    .reverse()
    .map((name) => path.join(directory, name))
}

/**
 * Deletes all but the `keep` newest backups, with their manifests.
 *
 * A backup directory nobody prunes is a disk full some weeks later discovered at
 * the worst time, and on a small disk that can take the database down. Pruning is
 * therefore the default rather than a flag: `keep` is how many are retained, and
 * the answer should be a number rather than a decision somebody remembers to make.
 */
export function pruneBackups(directory, keep) {
  const all = listBackups(directory)
  if (all.length <= keep) return []

  const removed = []
  for (const file of all.slice(keep)) {
    fs.rmSync(file, { force: true })
    fs.rmSync(
      path.join(directory, manifestFileName(path.basename(file))),
      { force: true },
    )
    fs.rmSync(`${file}.partial`, { force: true })
    removed.push(file)
  }
  return removed
}

/**
 * Checks whether a live process is holding this data directory open.
 *
 * `server.js` writes `<dataDir>/.lock` with its pid while it is listening, so a
 * restore can refuse rather than replace the file under a running server. That
 * replacement is the failure this exists to prevent: on Linux the rename succeeds,
 * the running process keeps its open handle to the old inode, and the platform
 * appears to have restored nothing while serving a database that no longer exists
 * on disk. It looks like a successful restore and a successful server at the same
 * time.
 *
 * The pid is checked rather than trusted, because a lock file outlives a crash. A
 * pid that is not alive means the file is stale and the restore may proceed.
 *
 * `ignoreSelf` exists for the other caller. A process deciding whether it may
 * *take* the lock has not written one yet, so a lock naming its own pid cannot be
 * a different live process - it is a leftover from a process that died and whose
 * pid was reissued, which a container's reset pid namespace makes ordinary rather
 * than rare (a fresh container hands `node` a small pid like 7 on every start).
 * Such a caller passes `ignoreSelf` and is not blocked by its own reused pid. A
 * restore must not, because there its own pid means the caller itself holds the
 * directory.
 */
export function liveLock(dataDir, { ignoreSelf = false } = {}) {
  const lockFile = path.join(dataDir, '.lock')
  if (!fs.existsSync(lockFile)) return null

  const pid = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null

  if (ignoreSelf && pid === process.pid) return null

  try {
    // Signal 0 tests for existence without sending anything. It is the only
    // portable way to ask whether a pid is alive, and it is allowed to throw
    // EPERM for a process owned by somebody else, which still means alive.
    process.kill(pid, 0)
    return { pid, file: lockFile }
  } catch (error) {
    if (error.code === 'EPERM') return { pid, file: lockFile }
    return null
  }
}

/**
 * Puts a verified backup in place of the live database.
 *
 * Order matters and is the reason this is not three lines:
 *
 *   1. Refuse while a server is listening, for the reason above.
 *   2. Verify the file *before* touching anything, so a bad backup cannot be
 *      discovered by having already destroyed the good database.
 *   3. Move the current database aside rather than deleting it. A restore that
 *      cannot be undone is not a recovery step, it is a second failure waiting for
 *      the next one; the displaced file is kept and its path printed.
 *   4. Remove the session secret, so no session predating the restore survives it.
 *
 * The displaced database keeps its own `-wal` and `-shm` siblings, which are moved
 * with it. Copying only the main file would leave a stale WAL describing a
 * different database, which is precisely the corruption described at the top of
 * this file.
 *
 * @returns {{restoredFrom: string, displaced: string|null, removedSessionSecret: boolean}}
 */
export function restoreBackup(file, options = {}) {
  const dataDir = options.dataDir
  const databaseFile = options.databaseFile ?? path.join(dataDir, 'kampala.db')

  const live = liveLock(dataDir)
  if (live) {
    throw new Error(
      `Refusing to restore: pid ${live.pid} is holding ${dataDir} open. ` +
        'Stop the server first, then restore.',
    )
  }

  const verified = verifyBackup(file)
  if (!verified.exists) {
    throw new Error(`There is no backup at ${file}.`)
  }
  if (verified.integrity.length !== 1 || verified.integrity[0] !== 'ok') {
    throw new Error(
      `Refusing to restore: ${path.basename(file)} failed its integrity check ` +
        `(${verified.integrity.slice(0, 3).join('; ')}).`,
    )
  }
  if (verified.checksum && !verified.checksum.matches) {
    throw new Error(
      `Refusing to restore: ${path.basename(file)} does not match the checksum in its ` +
        'manifest, so it is not the file that was written.',
    )
  }

  let displaced = null
  if (fs.existsSync(databaseFile)) {
    displaced = `${databaseFile}.replaced-${backupStamp()}`
    fs.renameSync(databaseFile, displaced)
    for (const suffix of ['-wal', '-shm']) {
      const sibling = `${databaseFile}${suffix}`
      if (fs.existsSync(sibling)) fs.renameSync(sibling, `${displaced}${suffix}`)
    }
  }

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  fs.copyFileSync(file, databaseFile)

  const secretFile = path.join(dataDir, '.session-secret')
  const removedSessionSecret = fs.existsSync(secretFile)
  if (removedSessionSecret) fs.rmSync(secretFile, { force: true })

  return { restoredFrom: file, displaced, removedSessionSecret, verified }
}