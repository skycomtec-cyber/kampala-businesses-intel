import fs from 'node:fs'
import path from 'node:path'

import { ValidationError } from '../core/errors.js'
import { runMaintenance } from './maintenance.js'
import { createBackup } from '../db/backup.js'

/**
 * The nightly work, run from inside the process.
 *
 * On a host this is a systemd timer's job: `kampala-intel-maintenance.timer` runs
 * `scripts/maintenance.js` at 03:17 and `kampala-intel-backup.timer` runs
 * `scripts/backup.js` at 03:47. A platform-as-a-service has no timer, so on one
 * the same two jobs have to be driven by the server itself or they never run at
 * all - and "never runs at all" means the retention windows in `/api/v1/meta`
 * describe a deletion that does not happen.
 *
 * Three decisions shape this file.
 *
 * It is off unless switched on. The host path already has timers, and a process
 * that also ran maintenance would do the work twice; more importantly, an install
 * that has not asked for a self-scheduling server should not get one. The switch
 * is `KIP_OPS_SCHEDULE`, so the platform sets it and the host does not.
 *
 * Due-ness is measured against a timestamp on disk, not against process uptime.
 * An interval that resets on every boot is an interval a frequently-redeployed
 * service never reaches: a platform that restarts its instance twice a day would
 * roll up never. The last run is written to `<dataDir>/.ops-state.json`, so a
 * restart resumes the cadence instead of restarting it. That file is the
 * equivalent of the `Persistent=true` on the systemd timers, and it exists for the
 * same reason.
 *
 * A failed run still advances the clock. This is the opposite of the harvest
 * scheduler, where a failed run deliberately does not reset a source's cadence,
 * and the difference is what is being retried. A harvest is a third party's page;
 * retrying it soon is cheap and likely to succeed. These jobs are local database
 * work, and a failure here is a persistent condition - a full disk, a database
 * that will not open - that a retry every few minutes would only turn into the
 * same error in the log every few minutes. The error is recorded in the state
 * file and logged at `error` level, so it is loud without being a flood; the next
 * scheduled attempt picks it up.
 */

/** The state file name, beside the database and the lock. */
const STATE_FILE = '.ops-state.json'

/**
 * How often the due check runs, in milliseconds.
 *
 * This is the resolution at which the interval is checked, not the interval: a due
 * run happens within ten minutes of becoming due. Nothing here is time-critical to
 * the minute, and a coarser check is less work for a process that is mostly
 * serving requests.
 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000

/**
 * How long after start the first check runs, in milliseconds.
 *
 * Delayed rather than immediate so a run never competes with the migrations, the
 * reference seed and the first requests a fresh deploy takes. Unref'd, so it does
 * not hold the process open and does not delay a shutdown.
 */
const INITIAL_DELAY_MS = 30 * 1000

/** Backups kept by the in-process job, matching `scripts/backup.js`. */
const BACKUP_KEEP = 14

/** Days re-rolled up on each run, matching `scripts/maintenance.js`. */
const MAINTENANCE_DAYS = 2

/**
 * Whether a scheduled run is due, given when it last ran.
 *
 * Pure, so the rule is tested against a fixed clock rather than by waiting. Never
 * run is always due: a service that has only just been told to schedule its own
 * work should do it once, not a day later. A timestamp that cannot be parsed is
 * treated as due for the same reason - a run once too often is better than never
 * again because a file was malformed.
 */
export function isRunDue({ lastRunAt = null, intervalHours, now = new Date() } = {}) {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new ValidationError(
      `The ops interval must be a positive number of hours, got ${intervalHours}.`,
    )
  }
  if (!lastRunAt) return true
  const last = Date.parse(lastRunAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= intervalHours * 3600000
}

/** Reads the state file, tolerating a missing or unreadable one. */
function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // Missing, empty or corrupt all mean the same thing: no recorded run, so the
    // first check is due. Treating a corrupt file as "recently run" would silently
    // disable the schedule, which is the failure this whole file avoids.
    return {}
  }
}

/** Writes the state file atomically enough that a crash cannot truncate it. */
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.partial`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

/**
 * Builds the scheduler. Nothing runs until `start()` is called.
 *
 * @param {object} app the open database handle and repositories
 * @param {object} config the resolved config (`config.ops`, `config.dataDir`, ...)
 * @param {object} [deps]
 * @param {object} [deps.logger] a logger with `info`/`error` (Fastify's `server.log` fits)
 * @param {() => Date} [deps.now] the clock, injected so a run is reproducible
 * @param {number} [deps.checkIntervalMs] how often to check due-ness
 * @param {number} [deps.initialDelayMs] how long after start to check the first time
 * @param {number} [deps.backupKeep] how many backups to retain
 * @param {number} [deps.maintenanceDays] how many days to roll up
 * @param {string} [deps.stateFile] where the last-run timestamp lives
 * @param {string} [deps.backupDir] where backups are written
 * @returns {{start: Function, stop: Function, checkNow: Function, runOnce: Function, isRunning: Function, nextDueAt: Function}}
 */
export function createScheduler(app, config, deps = {}) {
  const logger = deps.logger ?? console
  const now = deps.now ?? (() => new Date())
  const checkIntervalMs = deps.checkIntervalMs ?? CHECK_INTERVAL_MS
  const initialDelayMs = deps.initialDelayMs ?? INITIAL_DELAY_MS
  const backupKeep = deps.backupKeep ?? BACKUP_KEEP
  const maintenanceDays = deps.maintenanceDays ?? MAINTENANCE_DAYS
  const stateFile = deps.stateFile ?? path.join(config.dataDir, STATE_FILE)
  const backupDir = deps.backupDir ?? path.join(config.dataDir, 'backups')

  let running = false
  let checkTimer = null
  let initialTimer = null

  const enabled = Boolean(config.ops?.enabled)

  /** The next time a run is due, given the recorded last run. */
  function nextDueAt(lastRunAt) {
    if (!lastRunAt) return null
    const last = Date.parse(lastRunAt)
    if (Number.isNaN(last)) return null
    return new Date(last + config.ops.intervalHours * 3600000).toISOString()
  }

  /**
   * Runs maintenance and a backup once, and records the outcome.
   *
   * Both jobs run in one pass and either may fail without stopping the other: a
   * backup that cannot write should not also cost the retention purge, and a
   * maintenance failure should not cost the backup. What failed is collected and
   * logged; the state file records that an attempt happened, per the note above.
   */
  async function runOnce() {
    if (running) return { skipped: true, reason: 'already-running' }
    running = true
    const startedAt = now()
    const result = {
      startedAt: startedAt.toISOString(),
      maintenance: null,
      backup: null,
      errors: [],
    }

    try {
      try {
        const summary = runMaintenance(app, { days: maintenanceDays })
        result.maintenance = {
          days: summary.days,
          events: summary.events,
          signals: summary.signals,
          gapsWritten: summary.gaps?.gapsWritten ?? null,
          opportunitiesWritten: summary.gaps?.opportunitiesWritten ?? null,
          purged: summary.purged ?? null,
        }
        logger.info?.({ maintenance: result.maintenance }, 'scheduled maintenance finished')
      } catch (error) {
        result.errors.push(`maintenance: ${error.message}`)
        logger.error?.({ err: error }, 'scheduled maintenance failed')
      }

      try {
        const backup = await createBackup(app.db, {
          directory: backupDir,
          keep: backupKeep,
          // Stamped from the scheduler's clock rather than the wall clock, so a
          // run's backup is named for the run and a test with an injected clock is
          // reproducible instead of racing the second hand.
          date: startedAt,
          // Recorded in the manifest so a restore can say what the k-anonymity
          // floor was when the data was measured.
          kThreshold: config.privacy?.kThreshold ?? null,
        })
        result.backup = { file: backup.file, bytes: backup.manifest.bytes }
        logger.info?.({ backup: result.backup }, 'scheduled backup finished')
      } catch (error) {
        result.errors.push(`backup: ${error.message}`)
        logger.error?.({ err: error }, 'scheduled backup failed')
      }

      writeState(stateFile, {
        lastRunAt: startedAt.toISOString(),
        lastError: result.errors.length ? result.errors.join('; ') : null,
        maintenance: result.maintenance,
        backup: result.backup,
      })
    } finally {
      running = false
    }

    return result
  }

  /**
   * Checks whether a run is due and runs it if so.
   *
   * Exposed so a test (or an operator's one-off) can drive a single check against
   * a fixed clock without standing up the timers.
   */
  async function checkNow() {
    if (!enabled) return { skipped: true, reason: 'disabled' }
    const state = readState(stateFile)
    const lastRunAt = state.lastRunAt ?? null
    if (
      !isRunDue({
        lastRunAt,
        intervalHours: config.ops.intervalHours,
        now: now(),
      })
    ) {
      return { skipped: true, reason: 'not-due', lastRunAt, nextDueAt: nextDueAt(lastRunAt) }
    }
    return runOnce()
  }

  /** Starts the timers. A no-op (with a log line) when the schedule is off. */
  function start() {
    if (!enabled) {
      logger.info?.('self-scheduled maintenance is off (set KIP_OPS_SCHEDULE=true to enable)')
      return
    }
    if (checkTimer || initialTimer) return

    logger.info?.(
      { intervalHours: config.ops.intervalHours, checkIntervalMs, initialDelayMs },
      'self-scheduled maintenance is on',
    )

    const fire = () => {
      checkNow().catch((error) => {
        logger.error?.({ err: error }, 'scheduled ops check failed')
      })
    }

    initialTimer = setTimeout(fire, initialDelayMs)
    // Unref'd so neither timer keeps the process alive: a shutdown that clears
    // them is clean, and a shutdown that does not still exits.
    initialTimer.unref?.()
    checkTimer = setInterval(fire, checkIntervalMs)
    checkTimer.unref?.()
  }

  /** Stops the timers, if any. Safe to call more than once. */
  function stop() {
    if (initialTimer) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (checkTimer) {
      clearInterval(checkTimer)
      checkTimer = null
    }
  }

  return {
    start,
    stop,
    checkNow,
    runOnce,
    isRunning: () => running,
    nextDueAt,
  }
}
