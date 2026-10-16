#!/usr/bin/env node
/**
 * The process entry point.
 *
 * Deliberately small, because everything worth reading is somewhere else: config
 * in `src/config.js`, the database in `src/db`, the routes in `src/api`. What is
 * left here is the part that only exists at runtime.
 *
 *   - Bring the schema and the reference data up to date on the way up. A launcher
 *     that starts a server against a half-migrated database produces errors that
 *     look like application bugs, so `start` never has to remember to run a
 *     migration first.
 *   - Print the listening address on its own line. The Pinokio launcher reads that
 *     line to decide what to open in the browser.
 *   - Shut the database down cleanly. SQLite in WAL mode keeps recent writes in a
 *     side file, and a hard kill at the wrong moment leaves that behind.
 */

import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { openApp } from './db/index.js'
import { seedReferenceData, seedCatalogue } from './seed/index.js'
import { buildApi } from './api/index.js'
import { liveLock } from './db/backup.js'
import { createScheduler } from './ops/scheduler.js'
import { createHarvestScheduler } from './harvest/inprocess.js'

const config = loadConfig()
const app = openApp({ config })
seedReferenceData(app, { config })
// After the vocabulary, so the record has a category and a district to point at.
seedCatalogue(app, { config })

const server = await buildApi({ app, config })
let shuttingDown = false

/**
 * The nightly maintenance and backup, run from inside the process when there is
 * no systemd timer to run them - which is the platform-as-a-service case. Off
 * unless `KIP_OPS_SCHEDULE` is set, so a host that already has
 * `deploy/kampala-intel-*.timer` does not do the work twice.
 *
 * Started after the server is listening (below) and stopped on the way out, so a
 * deploy never leaves it running against a closed database.
 */
const scheduler = createScheduler(app, config, { logger: server.log })

/**
 * The scheduled harvest, run from inside the process when there is no external
 * timer driving it. Off unless `KIP_HARVEST_SCHEDULE` is set, and even when on
 * only plans that declare a cadence and are due are harvested.
 */
const harvestScheduler = createHarvestScheduler(app, config, { logger: server.log })

/**
 * A pid file beside the database, so a restore can tell that the server is up.
 *
 * `scripts/restore.js` refuses to replace a database a live process is using, and
 * this is the only way it can know. The alternative - opening the file and seeing
 * whether it locks - is unreliable here: WAL mode allows a second connection while
 * the first is running, so the database happily opens and the restore proceeds.
 * The rename then succeeds on Linux, the running server keeps its handle to the
 * old inode, and the platform reports a successful restore while serving a
 * database that is no longer on disk.
 *
 * Written before listening and removed on the way out, so a lock that exists means
 * a process that started. A lock left behind by a crash is not trusted: the
 * restore checks whether the pid is alive rather than whether the file is there.
 */
const LOCK_FILE = path.join(config.dataDir, '.lock')

/**
 * How long a shutdown may run before the process stops waiting for it.
 *
 * The clean path closes Fastify and checkpoints SQLite, and this is the backstop
 * for when that path stalls rather than the plan. It exists because a signal
 * handler that never returns is worse than an abrupt exit: the platform, seeing no
 * exit, sends SIGKILL after its own grace period, and the SIGKILL leaves the lock
 * file behind. The next start then reads a pid it has itself been given (a fresh
 * container reissues small pids, so `node` is pid 7 again) and - before the
 * own-pid rule below - refuses to run, which turns one slow stop into an outage
 * that does not clear on its own. So the deadline releases the lock before it
 * exits, whether or not the close returned.
 *
 * Below the ten seconds a `docker stop` allows, and far below systemd's
 * TimeoutStopSec=30, so it fires before either sends SIGKILL.
 */
const SHUTDOWN_DEADLINE_MS = 8000

/** Takes the lock, refusing rather than overwriting a live server's. */
function takeLock() {
  // `ignoreSelf: true` because this process has not written a lock yet, so a lock
  // that names our own pid is a leftover from a predecessor that died and whose
  // pid we have been reissued - the container-restart case described in
  // `liveLock`. Without it, a redeploy after an ungraceful stop could never start.
  const existing = liveLock(config.dataDir, { ignoreSelf: true })
  if (existing) {
    throw new Error(
      `Another server (pid ${existing.pid}) is already using ${config.dataDir}. ` +
        'Stop it first, or point KIP_DATA_DIR somewhere else.',
    )
  }
  fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, 'utf8')
}

/** Removes the lock, but only if it is still ours. */
function releaseLock() {
  try {
    if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(LOCK_FILE, { force: true })
    }
  } catch {
    // A lock file that cannot be read is not a reason to fail a clean shutdown.
  }
}

try {
  takeLock()
} catch (error) {
  // Before the signal handlers exist, so there is nothing to shut down cleanly.
  // The database is closed here rather than left to the exit, because WAL keeps
  // recent writes in a side file and this process should not be the reason a
  // checkpoint is skipped.
  process.stderr.write(`Failed to start: ${error.message}\n`)
  app.close()
  process.exit(1)
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  server.log.info({ signal }, 'shutting down')

  // First, so no new scheduled run starts against a database that is about to
  // close. A run already in flight is not interrupted; the backup uses SQLite's
  // online API and the maintenance jobs are short, so it finishes before the
  // close below reaches the database.
  scheduler.stop()
  harvestScheduler.stop()

  // Armed for the whole of the close, so a close that stalls still ends in an
  // exit that has released the lock. See SHUTDOWN_DEADLINE_MS.
  const deadline = setTimeout(() => {
    server.log.error({ signal }, 'shutdown did not finish; exiting and releasing the lock')
    releaseLock()
    process.exit(1)
  }, SHUTDOWN_DEADLINE_MS)
  deadline.unref()

  try {
    await server.close()
    app.close()
  } catch (error) {
    server.log.error({ err: error }, 'shutdown failed')
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    releaseLock()
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).then(() => process.exit(process.exitCode ?? 0))
  })
}

// An unhandled rejection leaves the process in a state nobody can reason about, so
// it is a hard stop rather than a warning.
process.on('unhandledRejection', (reason) => {
  server.log.error({ err: reason }, 'unhandled rejection')
  shutdown('unhandledRejection').then(() => process.exit(1))
})

try {
  const address = await server.listen({ host: config.host, port: config.port })

  // Kept on single, unadorned lines so the launcher's url capture has exactly one
  // pattern to match, whatever else the structured logger prints around it.
  process.stdout.write(`\nKampala Intelligence Platform listening at ${address}\n`)
  process.stdout.write(`API base: ${address}${config.api.prefix}\n`)
  process.stdout.write(`Database: ${config.database.file}\n\n`)

  // After listening, so the timers never delay the port the platform health-checks.
  // A no-op unless KIP_OPS_SCHEDULE is set.
  scheduler.start()
  harvestScheduler.start()
} catch (error) {
  process.stderr.write(`Failed to start: ${error.message}\n`)
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `Port ${config.port} is already in use. Set KIP_PORT to a free port and start again.\n`,
    )
  }
  app.close()
  process.exit(1)
}
