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
import { runMaintenance } from '../src/ops/maintenance.js'

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
  // The work itself lives in `src/ops/maintenance.js`, because the server runs the
  // same three jobs on a timer when there is no systemd to run this script. This
  // file is now only the command: argument parsing, reporting and exit code.
  const summary = runMaintenance(app, {
    days: args.days,
    from: args.from,
    to: args.to,
    rollup: args.rollup,
    gaps: args.gaps,
    purge: args.purge,
    windowDays: args.windowDays,
  })

  if (args.rollup) {
    log(
      `Rolled up ${summary.days} day(s): ${summary.events} search event(s) into ${summary.signals} signal row(s).`,
    )
  }

  if (summary.gaps) {
    log(
      `Gaps: ${summary.gaps.gapsWritten} signal(s) measured over ${summary.gaps.windowDays} day(s), ` +
        `${summary.gaps.gapsSuppressed} suppressed by the k-anonymity floor, ` +
        `${summary.gaps.opportunitiesWritten} opportunit(y/ies) written.`,
    )
  }

  if (summary.purged) {
    const purged = summary.purged
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
