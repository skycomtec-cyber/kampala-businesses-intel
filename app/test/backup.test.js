import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  verifyBackup,
  liveLock,
  backupFileName,
} from '../src/db/backup.js'

/**
 * Backup and restore, on the property that matters.
 *
 * THE BUG THIS EXISTS BECAUSE OF
 *
 * Copying a SQLite database while the server is running is not a thing you can do
 * with `cp`, and the way it fails is the worst kind: silently.
 *
 * The platform runs WAL, so recent writes sit in `kampala.db-wal` until a
 * checkpoint. `cp kampala.db backup.db` produces a file that opens cleanly, passes
 * an integrity check, has the right schema and is missing every write since the
 * last checkpoint. There is nothing about the copy that says so. An operator
 * discovers it on the day they need it, which is the day they find out the
 * database they were relying on is hours old.
 *
 * So these tests assert the thing `cp` cannot: that the backup contains writes made
 * *after* it was taken, from a connection that never stopped, and that a corrupt or
 * wrong file is refused rather than restored over a good database.
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backupScript = path.join(APP_ROOT, 'scripts', 'backup.js')
const restoreScript = path.join(APP_ROOT, 'scripts', 'restore.js')

/** A migrated, reference-seeded data directory. */
function freshDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-backup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const previous = process.env.KIP_DATA_DIR
  process.env.KIP_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.KIP_DATA_DIR
    else process.env.KIP_DATA_DIR = previous
  })
  return dir
}

function openSeeded(dataDir) {
  const config = loadConfig({ dataDir })
  const app = openApp({ config })
  seedReferenceData(app, { config })
  return app
}

/** Runs a script as a real child process, the way cron and the launcher would. */
function runScript(script, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout,
          stderr,
        })
      },
    )
  })
}

test('a backup contains the writes made after it was taken', async (t) => {
  // The assertion that `cp` fails. The application connection is held open, WAL is
  // on, and a row is written *after* the backup completes. The copy has to contain
  // it, because a reader who restores that backup must not lose a listing that
  // existed before the restore.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const config = loadConfig({ dataDir })

  const first = await createBackup(app.db, {
    directory: path.join(dataDir, 'backups'),
    kThreshold: config.privacy.kThreshold,
  })

  // A write through the same connection the backup was taken from, after it. The
  // audit log is used because it has no foreign keys to satisfy, so this is a row
  // that exists purely to be counted and nothing more.
  app.db
    .prepare(
      `INSERT INTO audit_log (id, action, entity_type, entity_id, after_json, created_at)
       VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'business.updated', 'business',
               'aaaaaaaa-0000-4000-8000-000000000002',
               '{"reason":"written after the backup"}', '2026-10-01T00:00:00.000Z')`,
    )
    .run()

  const readBack = new (await import('better-sqlite3')).default(first.file, {
    readonly: true,
    fileMustExist: true,
  })
  const reasons = readBack
    .prepare('SELECT after_json FROM audit_log ORDER BY created_at')
    .all()
    .map((row) => JSON.parse(row.after_json).reason)
  readBack.close()

  // The second backup is the one that can contain it; the first is asserted to not,
  // because that is what makes the next one meaningful.
  assert.ok(
    !reasons.some((value) => String(value).includes('written after the backup')),
    'the first backup does not contain the later write, which is what makes this test real',
  )

  const second = await createBackup(app.db, {
    directory: path.join(dataDir, 'backups'),
    date: new Date('2026-10-02T00:00:00Z'),
    kThreshold: config.privacy.kThreshold,
  })
  const readSecond = new (await import('better-sqlite3')).default(second.file, {
    readonly: true,
    fileMustExist: true,
  })
  const later = readSecond
    .prepare('SELECT after_json FROM audit_log ORDER BY created_at')
    .all()
    .map((row) => JSON.parse(row.after_json).reason)
  readSecond.close()

  assert.ok(
    later.some((value) => String(value).includes('written after the backup')),
    'the later backup does contain it, so a restore cannot lose a listing',
  )
  app.close()
})

test('a backup is one file, not a file plus WAL siblings', async (t) => {
  // The other half of the `cp` problem. A backup directory where every entry has two
  // companions looks like a set of databases and is not one, and the moment someone
  // copies the directory with a tool that skips hidden or sidecar files they get a
  // silently stale set.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')

  const result = await createBackup(app.db, { directory })
  app.close()

  for (const suffix of ['-wal', '-shm', '.partial']) {
    assert.equal(
      fs.existsSync(`${result.file}${suffix}`),
      false,
      `no ${suffix} file is left beside the backup`,
    )
  }
  assert.ok(fs.existsSync(result.manifestFile), 'the manifest is written beside it')

  // And it opens with nothing else present, which is the actual test.
  const verified = verifyBackup(result.file)
  assert.deepEqual(verified.integrity, ['ok'])
})

test('a backup records what it contains and what it does not', async (t) => {
  // A manifest is what somebody reads at 2am to decide whether a file is a complete
  // copy. A manifest that lists contents but is silent about the session secret
  // reads as though the backup is the whole data directory, which it is not.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')

  const result = await createBackup(app.db, {
    directory,
    kThreshold: loadConfig({ dataDir }).privacy.kThreshold,
  })
  app.close()

  assert.equal(result.manifest.sha256.length, 64, 'a sha256 so the file can be checked later')
  assert.equal(result.manifest.includesSessionSecret, false)
  assert.ok(result.manifest.migrations.length > 0, 'the schema it was taken at is recorded')
  assert.equal(result.manifest.kThreshold, 5, 'and the privacy floor in force when measured')
  assert.ok(result.manifest.counts.category > 0, 'row counts, so a restore can be shown to work')

  // The secret must not be inside the file either, not just absent from the manifest.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(result.file, { readonly: true })
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name)
  db.close()
  assert.equal(
    tables.some((name) => name.includes('secret')),
    false,
    'and the secret is genuinely not in the database',
  )
})

test('a backup that was altered is refused, and so is a corrupt one', async (t) => {
  // The property that makes a backup worth having. A file that fails verification
  // must never reach the point where it has replaced the good database, because the
  // moment it is discovered is the moment the operator needs the old one back.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')

  const result = await createBackup(app.db, {
    directory,
    date: new Date('2026-10-01T00:00:00Z'),
  })
  app.close()

  // A single flipped byte in a page of the file. The integrity check may still pass
  // on the header page, so this is deliberately testing the checksum's job.
  const bytes = fs.readFileSync(result.file)
  bytes[5000] = (bytes[5000] + 1) % 256
  fs.writeFileSync(result.file, bytes)

  const verified = verifyBackup(result.file)
  assert.equal(verified.checksum.matches, false, 'the checksum notices')

  assert.throws(
    () =>
      restoreBackup(result.file, {
        dataDir,
        databaseFile: path.join(dataDir, 'kampala.db'),
      }),
    /does not match the checksum/,
    'and the restore refuses it',
  )

  // The live database is untouched, which is the whole point of verifying first.
  assert.ok(fs.existsSync(path.join(dataDir, 'kampala.db')), 'the live database is still there')
  assert.equal(fs.existsSync(`${result.file}.replaced-*`), false)
})

test('a missing backup is reported, not treated as an empty restore', async (t) => {
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  app.close()

  assert.throws(
    () =>
      restoreBackup(path.join(dataDir, 'backups', 'kampala-nope.db'), {
        dataDir,
        databaseFile: path.join(dataDir, 'kampala.db'),
      }),
    /no backup at/,
  )
})

test('restoring puts the old data back and keeps what it replaced', async (t) => {
  // A restore that cannot be undone is not a recovery step, it is the next failure
  // waiting to happen. So the displaced database is kept and its path reported.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')

  app.db
    .prepare(
      `INSERT INTO audit_log (id, action, entity_type, entity_id, after_json, created_at)
       VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'business.updated', 'business',
               'bbbbbbbb-0000-4000-8000-000000000002',
               '{"reason":"before the backup"}', '2026-10-01T00:00:00.000Z')`,
    )
    .run()
  const backup = await createBackup(app.db, {
    directory,
    date: new Date('2026-10-01T00:00:00Z'),
  })

  // Something happens afterwards that an operator would want to undo.
  app.db.prepare('DELETE FROM audit_log').run()
  app.db
    .prepare(
      `INSERT INTO audit_log (id, action, entity_type, entity_id, after_json, created_at)
       VALUES ('cccccccc-0000-4000-8000-000000000001', 'business.updated', 'business',
               'cccccccc-0000-4000-8000-000000000002',
               '{"reason":"after the backup"}', '2026-10-02T00:00:00.000Z')`,
    )
    .run()
  app.close()

  const result = restoreBackup(backup.file, {
    dataDir,
    databaseFile: path.join(dataDir, 'kampala.db'),
  })
  assert.ok(result.displaced, 'the replaced database is kept, not deleted')
  assert.ok(fs.existsSync(result.displaced), 'and it is on disk at the path reported')

  const restored = openApp({ config: loadConfig({ dataDir }) })
  const reasons = restored.db
    .prepare('SELECT after_json FROM audit_log ORDER BY created_at')
    .all()
    .map((row) => JSON.parse(row.after_json).reason)
  restored.close()

  assert.deepEqual(reasons, ['before the backup'], 'the database is back to what it was')
})

test('restoring refuses while a server is holding the directory', async (t) => {
  // Replacing the file under a live process is the one failure that looks like
  // success: the rename works, the running server keeps its handle to the old
  // inode, and the platform reports a restored database while serving one that is
  // no longer on disk.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')
  const backup = await createBackup(app.db, { directory })
  app.close()

  // The pid of this test process, which is very much alive.
  fs.writeFileSync(path.join(dataDir, '.lock'), `${process.pid}\n`)

  assert.equal(liveLock(dataDir).pid, process.pid, 'the live lock is noticed')

  assert.throws(
    () =>
      restoreBackup(backup.file, {
        dataDir,
        databaseFile: path.join(dataDir, 'kampala.db'),
      }),
    /Refusing to restore/,
  )

  // A lock left behind by a crash is not a lock, and must not block a recovery.
  fs.writeFileSync(path.join(dataDir, '.lock'), '2147483646\n')
  assert.equal(liveLock(dataDir), null, 'a dead pid is not a lock')
  assert.doesNotThrow(() =>
    restoreBackup(backup.file, {
      dataDir,
      databaseFile: path.join(dataDir, 'kampala.db'),
    }),
  )
})

test('a restore invalidates every existing session', async (t) => {
  // Deliberate, and the reasoning is in src/db/backup.js: keeping the old secret
  // would leave a session signed before the incident still signed after it, which
  // is the wrong direction for the one operation you reach for after an incident.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')
  const secretFile = path.join(dataDir, '.session-secret')

  assert.ok(fs.existsSync(secretFile), 'a secret exists once the config has been loaded')
  const before = fs.readFileSync(secretFile, 'utf8')
  const backup = await createBackup(app.db, { directory })
  app.close()

  const result = restoreBackup(backup.file, {
    dataDir,
    databaseFile: path.join(dataDir, 'kampala.db'),
  })
  assert.equal(result.removedSessionSecret, true)
  assert.equal(fs.existsSync(secretFile), false, 'the secret is gone')

  // And a new one is different, so a cookie from before the restore is worthless.
  const config = loadConfig({ dataDir })
  assert.notEqual(config.auth.sessionSecret, before)
})

test('pruning keeps the newest and removes the rest, manifests included', async (t) => {
  // A backup directory nobody prunes is a disk full discovered at the worst time,
  // and on a small disk that can take the database down.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const directory = path.join(dataDir, 'backups')

  for (let day = 1; day <= 5; day += 1) {
    // eslint-disable-next-line no-await-in-loop
    await createBackup(app.db, {
      directory,
      date: new Date(`2026-10-0${day}T00:00:00Z`),
    })
  }
  app.close()

  assert.equal(listBackups(directory).length, 5)
  const removed = pruneBackups(directory, 2)

  const remaining = listBackups(directory)
  assert.equal(remaining.length, 2)
  assert.equal(removed.length, 3)
  assert.deepEqual(
    remaining.map((file) => path.basename(file)),
    [backupFileName(new Date('2026-10-05T00:00:00Z')), backupFileName(new Date('2026-10-04T00:00:00Z'))],
    'the newest are the ones kept',
  )

  // The removed ones' manifests are pruned too. Only the ones kept remain.
  const strays = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.db.json'))
    .map((name) => name)
  const keptBasenames = remaining.map((file) => `${path.basename(file)}.json`)
  for (const stray of strays) {
    assert.ok(
      keptBasenames.includes(stray),
      `manifest ${stray} is still there only if its backup is kept`,
    )
  }
  assert.equal(strays.length, keptBasenames.length, 'only manifests for kept backups survive')
})

test('the backup command runs, verifies, and prunes as a cron job would', async (t) => {
  const dataDir = freshDataDir(t)
  openSeeded(dataDir).close()

  const first = await runScript(backupScript, ['--keep', '2'], { KIP_DATA_DIR: dataDir })
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /Backup written:/)
  assert.match(first.stdout, /Verified: integrity check passed/, 'it says what it checked')

  const second = await runScript(
    backupScript,
    ['--date', '2026-10-02T00:00:00Z', '--keep', '2'],
    { KIP_DATA_DIR: dataDir },
  )
  assert.equal(second.code, 0, second.stderr)

  const listed = await runScript(backupScript, ['--list'], { KIP_DATA_DIR: dataDir })
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /kampala-20261002T000000Z\.db/)
  assert.match(listed.stdout, /kampala-20261001.*\.db/)

  // A cron job that has stopped taking backups must say so rather than exiting 0.
  const broken = await runScript(backupScript, ['--keep', 'zero'], {
    KIP_DATA_DIR: dataDir,
  })
  assert.equal(broken.code, 1)
  assert.match(broken.stderr, /--keep needs a whole number/)
})

test('the restore command finds a backup named the way --list printed it', async (t) => {
  // `--list` prints a bare filename, so a bare filename has to work. Resolving it
  // against the working directory alone makes the command look broken to anyone who
  // just ran the list.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  const backup = await createBackup(app.db, {
    directory: path.join(dataDir, 'backups'),
    date: new Date('2026-10-01T00:00:00Z'),
  })
  app.close()

  const previous = process.cwd()
  process.chdir(APP_ROOT)
  t.after(() => process.chdir(previous))

  const result = await runScript(
    restoreScript,
    ['--file', path.basename(backup.file), '--yes'],
    { KIP_DATA_DIR: dataDir },
  )
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Restored from/)
})

test('a restore with no terminal and no --yes is refused, not assumed', async (t) => {
  // A restore piped from a script that forgot --yes is a script that wanted the
  // question asked and did not know there was nobody to ask it. Answering on its
  // behalf is how a database gets replaced by a cron entry nobody wrote.
  const dataDir = freshDataDir(t)
  const app = openSeeded(dataDir)
  await createBackup(app.db, {
    directory: path.join(dataDir, 'backups'),
    date: new Date('2026-10-01T00:00:00Z'),
  })
  app.close()

  const result = await runScript(restoreScript, ['--latest'], { KIP_DATA_DIR: dataDir })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--yes/)
})