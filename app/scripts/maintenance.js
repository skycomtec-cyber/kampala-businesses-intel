#!/usr/bin/env node
/**
 * The scheduled work, as a command.
 *
 * Three jobs that cannot happen inside a request:
 *
 *   1. Rolling search events up into `demand_signal_daily`. The insights routes
 *      only ever read the rollup, so without this the public opportunity view is
 *      permanently empty no matter how many people search. A request is never
 *      made to wait for a rollup, because a slow rollup must degrade freshness
 *      and never lose a search.
 *   2. Measuring the gaps. Rolling demand up is only half the loop: it records
 *      what people asked for, and nothing was comparing that against the supply
 *      the platform actually has. This job runs the engine, which is what puts
 *      rows in `gap_snapshot` and `opportunity`. It runs after the rollup rather
 *      than independently so that a run never measures a day that has not been
 *      rolled up yet.
 *   3. Enforcing the retention windows. The raw query table is the only table
 *      that can identify a person, and it is deleted whether or not anyone runs
 *      this script, but a platform that only purges when asked is a platform
 *      that eventually does not.
 *
 * All three are idempotent, so running it twice is the same as running it once.
 * It rolls up the last few days rather than today alone, because a launch, a
 * crash or a laptop that was asleep at midnight all leave a day behind and there
 * is no scheduler in the launcher to notice.
 *
 * Usage:
 *   node scripts/maintenance.js                 yesterday and today
 *   node scripts/maintenance.js --days 7        the last 7 days
 *   node scripts/maintenance.js --from 2026-01-01 --to 2026-01-31
 *   node scripts/maintenance.js --no-rollup     retention only
 *   node scripts/maintenance.js --no-gaps       do not measure gaps
 *   node scripts/maintenance.js --no-purge      rollup and gaps only
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { runGapEngine } from '../src/engine/gaps.js'

const DAY_MS = 86400000

function toDayString(date) {
  return date.toISOString().slice(0, 10)
}

function parseArgs(argv) {
  const args = {
    days: 2,
    rollup: true,
    gaps: true,
    purge: true,
    from: null,
    to: null,
    windowDays: null,
    quiet: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--days') {
      args.days = Math.max(1, Math.min(90, Number.parseInt(value, 10) || args.days))
      index += 1
    } else if (flag === '--from') {
      args.from = value
      index += 1
    } else if (flag === '--to') {
      args.to = value
      index += 1
    } else if (flag === '--window') {
      args.windowDays = Math.max(1, Math.min(365, Number.parseInt(value, 10) || 30))
      index += 1
    } else if (flag === '--no-rollup') {
      args.rollup = false
    } else if (flag === '--no-gaps') {
      args.gaps = false
    } else if (flag === '--no-purge') {
      args.purge = false
    } else if (flag === '--quiet') {
      args.quiet = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const log = (message) => {
  if (!args.quiet) process.stdout.write(`${message}\n`)
}

const config = loadConfig()
const app = openApp({ config })

try {
  if (args.rollup) {
    const to = args.to ? new Date(`${args.to}T00:00:00.000Z`) : new Date()
    const from = args.from
      ? new Date(`${args.from}T00:00:00.000Z`)
      : new Date(to.getTime() - (args.days - 1) * DAY_MS)
    from.setUTCHours(0, 0, 0, 0)
    to.setUTCHours(0, 0, 0, 0)

    let signals = 0
    let events = 0
    let days = 0
    for (
      let cursor = new Date(from);
      cursor <= to;
      cursor = new Date(cursor.getTime() + DAY_MS)
    ) {
      const result = app.demand.rollupDay(toDayString(cursor))
      signals += result.signals
      events += result.events
      days += 1
    }
    log(
      `Rolled up ${days} day(s): ${events} search event(s) into ${signals} signal row(s).`,
    )
  }

  if (args.gaps) {
    // Runs last among the measuring jobs, and only if the rollup happened, so the
    // engine never measures a day that is still missing from the rollup. A failed
    // run is recorded as failed in intelligence_run and rethrown, which fails this
    // script: a gap engine that cannot run should be loud, not quietly skipped.
    const run = runGapEngine(app, {
      windowDays: args.windowDays ?? undefined,
    })
    log(
      `Gaps: ${run.gapsWritten} signal(s) measured over ${run.windowDays} day(s), ` +
        `${run.gapsSuppressed} suppressed by the k-anonymity floor, ` +
        `${run.opportunitiesWritten} opportunit(y/ies) written.`,
    )
  }

  if (args.purge) {
    const purged = app.demand.purgeExpired()
    const total = purged.rawQueries + purged.searchEvents + purged.interactions
    log(
      `Retention: removed ${purged.rawQueries} raw query/queries, ` +
        `${purged.searchEvents} search event(s), ${purged.interactions} interaction(s)` +
        `${total === 0 ? ' (nothing had expired).' : '.'}`,
    )
  }
} catch (error) {
  process.stderr.write(`Maintenance failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
