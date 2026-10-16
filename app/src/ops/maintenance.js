import { runGapEngine } from '../engine/gaps.js'

/**
 * The scheduled work, as a function rather than a command.
 *
 * The same three jobs `scripts/maintenance.js` runs, extracted so the server can
 * run them on a timer of its own. There is more than one caller on purpose: a
 * host runs them from a systemd timer, a platform-as-a-service has no timer and
 * runs them from the process, and both must do exactly the same thing. Two copies
 * of this logic would be two things to keep in agreement, and the privacy windows
 * are enforced by one of them.
 *
 *   1. Rolling search events up into `demand_signal_daily`. The insights routes
 *      only ever read the rollup, so without this the public opportunity view is
 *      permanently empty no matter how many people search.
 *   2. Measuring the gaps against that rollup, so `gap_snapshot` and `opportunity`
 *      have rows. It runs after the rollup rather than beside it, so a run never
 *      measures a day that has not been rolled up yet.
 *   3. Enforcing the retention windows. `search_query_raw` is the only table that
 *      can identify a person, and it exists to be deleted on schedule.
 *
 * All three are idempotent, so running twice is running once. It rolls up the
 * last few days rather than today alone, because a launch, a crash or a machine
 * that was asleep at midnight all leave a day behind and there is no scheduler to
 * notice.
 */

const DAY_MS = 86400000

/** `YYYY-MM-DD` for a moment, which is the key `rollupDay` reads. */
function toDayString(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Runs the maintenance jobs and reports what each one did.
 *
 * @param {object} app the open database handle and repositories
 * @param {object} [options]
 * @param {number} [options.days=2] how many days back to roll up
 * @param {string|null} [options.from] first day to roll up (`YYYY-MM-DD`)
 * @param {string|null} [options.to] last day to roll up (`YYYY-MM-DD`)
 * @param {boolean} [options.rollup=true] run the demand rollup
 * @param {boolean} [options.gaps=true] run the gap engine
 * @param {boolean} [options.purge=true] enforce the retention windows
 * @param {number|null} [options.windowDays=null] the gap engine's window
 * @param {Date} [options.now=new Date()] the clock, injected so a run is fixed
 * @returns {{days: number, events: number, signals: number, gaps: object|null, purged: object|null}}
 */
export function runMaintenance(app, options = {}) {
  const {
    days = 2,
    from = null,
    to = null,
    rollup = true,
    gaps = true,
    purge = true,
    windowDays = null,
    now = new Date(),
  } = options

  const summary = { days: 0, events: 0, signals: 0, gaps: null, purged: null }

  if (rollup) {
    // Cloned rather than used directly, so normalising the time-of-day below does
    // not mutate the caller's clock.
    const last = to ? new Date(`${to}T00:00:00.000Z`) : new Date(now)
    const first = from
      ? new Date(`${from}T00:00:00.000Z`)
      : new Date(last.getTime() - (days - 1) * DAY_MS)
    first.setUTCHours(0, 0, 0, 0)
    last.setUTCHours(0, 0, 0, 0)

    for (let cursor = new Date(first); cursor <= last; cursor = new Date(cursor.getTime() + DAY_MS)) {
      const result = app.demand.rollupDay(toDayString(cursor))
      summary.signals += result.signals
      summary.events += result.events
      summary.days += 1
    }
  }

  if (gaps) {
    // Runs after the rollup, so when both are on the engine never measures a day
    // that is still missing from it. It is not gated on `rollup` because the two
    // are independent switches: an operator who passed `--no-rollup` still asked
    // for gaps. A failed engine run is recorded as failed in `intelligence_run`
    // and rethrown, which fails the caller: a gap engine that cannot run should be
    // loud, not quietly skipped.
    summary.gaps = runGapEngine(app, { windowDays: windowDays ?? undefined })
  }

  if (purge) {
    summary.purged = app.demand.purgeExpired()
  }

  return summary
}
