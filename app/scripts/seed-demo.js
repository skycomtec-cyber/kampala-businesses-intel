#!/usr/bin/env node
/**
 * Builds the demonstration database.
 *
 * This exists because the platform cannot be evaluated on an empty install. With one
 * pending business and two searchers, every finding is suppressed on the
 * k-anonymity floor and every supply count is zero, so neither the gap scoring nor
 * the coverage model can be looked at. A demonstration dataset fixes that, and
 * `demo-data.js` explains why it has to be invented and what is real about it.
 *
 * THE GUARD
 *
 * This script will not write to the real install, and that is a refusal rather than
 * a warning. It compares the configured data directory against the default and
 * stops if they are the same, so a demonstration cannot be created by forgetting an
 * environment variable, by a mistyped path that resolves back to the default, or by
 * running this from the wrong directory. There is no flag that overrides it, because
 * the flag is the failure mode: the one time someone would use `--force` is the one
 * time the install is already in trouble.
 *
 * The second guard is that an existing database with real content is not extended.
 * A demonstration is built once into an empty directory. Pointing this at a database
 * that already holds businesses is refused, so this cannot become a way to add
 * invented traders to somebody's directory.
 *
 * WHAT IT DOES, IN THE ORDER THE PLATFORM DOES IT
 *
 * Reference data, then the demonstration businesses through the review path, then
 * the reviews and photographs against those businesses, then the searches as events,
 * then the daily rollup, then the gap engine. The last two steps call the same
 * functions `scripts/maintenance.js` calls, so the demonstration is produced by the
 * platform rather than by this file. The photographs are written to the media
 * directory beside the database, the same one the server reads them back from.
 *
 * Usage:
 *   KIP_DATA_DIR=../data-demo node scripts/seed-demo.js
 *   KIP_DATA_DIR=../data-demo KIP_DEMO_ADMIN_EMAIL=demo@example.com \
 *     KIP_DEMO_ADMIN_PASSWORD=... node scripts/seed-demo.js
 *   node scripts/seed-demo.js --help     the demo directory it would use
 */

import path from 'node:path'
import process from 'node:process'
import { APP_ROOT, loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'
import { demoCoverage, seedDemo } from '../src/seed/demo.js'
import { DEMO_DEMAND } from '../src/seed/demo-data.js'
import { runGapEngine } from '../src/engine/gaps.js'
import { createMediaStore } from '../src/media/index.js'

const DAY_MS = 86400000
const DEFAULT_DATA_DIR = path.join(APP_ROOT, 'data')
const DEFAULT_DEMO_DIR = path.resolve(APP_ROOT, '..', 'data-demo')

const log = (message) => process.stdout.write(`${message}\n`)

/**
 * A refusal, as opposed to a failure.
 *
 * The distinction matters to whoever runs this: "I will not do that" and "that did
 * not work" call for different responses, and collapsing them into one message is
 * how a guard rail gets ignored the one time it is inconvenient.
 */
class GuardError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'GuardError'
    this.detail = detail ?? null
  }
}

/**
 * Refuses to go anywhere near the real install.
 *
 * This runs before `loadConfig`, because the check has to be able to refuse rather
 * than merely complain after the real database has been opened. It resolves both
 * paths to absolute before comparing them, so a relative `KIP_DATA_DIR=data` fails
 * the same way an absent one does instead of quietly resolving to the install.
 */
function resolveDemoDir() {
  if (process.argv.includes('--help')) {
    log('The demonstration database belongs here:')
    log(`  ${DEFAULT_DEMO_DIR}`)
    log('')
    log('On PowerShell:')
    log(`  $env:KIP_DATA_DIR="${DEFAULT_DEMO_DIR}"; node scripts/seed-demo.js`)
    log('')
    log('On bash:')
    log(`  KIP_DATA_DIR="${DEFAULT_DEMO_DIR}" node scripts/seed-demo.js`)
    process.exit(0)
  }

  const configured = process.env.KIP_DATA_DIR
  if (!configured) {
    throw new GuardError(
      'Refusing to run: KIP_DATA_DIR is not set, so this would build the demonstration ' +
        'inside the real install.',
      `Set it to a directory of its own, for example:\n  $env:KIP_DATA_DIR="${DEFAULT_DEMO_DIR}"`,
    )
  }

  const dataDir = path.resolve(configured)
  if (dataDir === path.resolve(DEFAULT_DATA_DIR)) {
    throw new GuardError(
      `Refusing to run: KIP_DATA_DIR is the real install's data directory (${DEFAULT_DATA_DIR}).`,
      'The demonstration is invented content and belongs in a database of its own.',
    )
  }
  return dataDir
}

function toDayString(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Rolls up every day the dataset touches, today included.
 *
 * The number of days comes from the dataset rather than being fixed, so widening a
 * demand row does not quietly leave part of it unrolled and produce a demonstration
 * that is missing the very demand someone added.
 */
function rollupDemoWindow(app, now) {
  const span = DEMO_DEMAND.reduce((widest, row) => Math.max(widest, row.days ?? 1), 1)
  let events = 0
  let signals = 0
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * DAY_MS)
    const result = app.demand.rollupDay(toDayString(day))
    events += result.events
    signals += result.signals
  }
  return { span, events, signals }
}

/**
 * Refuses to add invented traders to a database that already has any.
 *
 * This counts every business, not just the ones that are not demonstration records.
 * The narrower test sounds safer and is worse: a demonstration directory already
 * holds thirty-odd records that all carry the demonstration source id, so it would
 * pass, and the script would build the whole dataset again on top of it. Running
 * this twice would give sixty businesses and a coverage picture that describes
 * nothing. A demonstration is built once, into an empty directory, and being
 * un-rerunnable is the price of never guessing whether it already ran.
 */
function assertNoExistingBusinesses(app) {
  const existing = app.db.prepare('SELECT COUNT(*) AS n FROM business').get()
  if (existing.n > 0) {
    throw new GuardError(
      `Refusing to run: that database already holds ${existing.n} business record(s).`,
      'Build the demonstration in an empty directory. Delete the demonstration ' +
        'directory and run this again, or point KIP_DATA_DIR at a new one. A real ' +
        'directory must not gain invented listings, and this script is the wrong ' +
        'tool for adding them.',
    )
  }
}

/**
 * Refuses if the database file is not the one inside the demonstration directory.
 *
 * `loadConfig` resolves the database file from `KIP_DB_FILE` first and only falls
 * back to `<dataDir>/kampala.db`, and the environment variable wins. An operator
 * who has pointed `KIP_DB_FILE` at their real install - which is a reasonable thing
 * to have done, and is how the config file is documented to work - would then pass
 * the directory check above and have the demonstration written straight into the
 * real database. The check has to be on the file that is actually about to be
 * opened, which is the only one that can be sure.
 */
function assertDatabaseIsInside(config, dataDir) {
  const databaseFile = path.resolve(config.database.file)
  const inside = path.relative(path.resolve(dataDir), databaseFile)
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new GuardError(
      `Refusing to run: the database file (${databaseFile}) is outside the ` +
        `demonstration directory (${dataDir}).`,
      'KIP_DB_FILE is overriding where the database is read from. Unset it for ' +
        'this run, so the demonstration uses its own file.',
    )
  }
}

/**
 * An operator account, so the demonstration can actually be signed into.
 *
 * Without one the public pages work and the whole admin surface - the review queue,
 * the opportunity triage - is unreachable, which is most of what a demonstration is
 * for. The password is generated rather than defaulted, and printed once, so there
 * is no well-known credential sitting in a file.
 */
function ensureDemoAdmin(app) {
  const email = process.env.KIP_DEMO_ADMIN_EMAIL
  if (!email) return null
  const existing = app.users.list()
  if (existing.length > 0) return null

  const password =
    process.env.KIP_DEMO_ADMIN_PASSWORD ??
    `demo-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
  app.users.create({
    email,
    password,
    displayName: 'Demo Operator',
    role: 'admin',
    status: 'active',
  })
  return { email, password }
}

function main() {
  const dataDir = resolveDemoDir()
  const config = loadConfig({ dataDir })
  assertDatabaseIsInside(config, dataDir)
  const app = openApp({ config })
  // The same directory the server reads from, so a photo written here is one the
  // gallery serves without any further step.
  const media = createMediaStore({ dir: config.mediaDir })

  try {
    assertNoExistingBusinesses(app)

    const reference = seedReferenceData(app, { config })
    const seeded = seedDemo(app, { media })
    const rolled = rollupDemoWindow(app, new Date())
    const run = runGapEngine(app)
    const coverage = demoCoverage(app)
    const admin = ensureDemoAdmin(app)

    const opportunities = app.intelligence.opportunities({}).items

    const tally = (rows) => {
      const counts = { published: 0, pending: 0, rejected: 0 }
      for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1
      return `${counts.published} published, ${counts.pending} pending, ${counts.rejected} rejected`
    }

    log(`Demonstration database built at ${dataDir}`)
    log(
      `  Reference: ${reference.locations} location(s), ${reference.categories} categor(ies), ` +
        `${reference.skills} skill(s).`,
    )
    log(`  Supply:    ${seeded.businesses.length} published business record(s).`)
    log(
      `  Demand:    ${seeded.phrases.length} phrase(s), ${rolled.events} search event(s) over ` +
        `${rolled.span} day(s) -> ${rolled.signals} signal row(s).`,
    )
    log(`  Ratings:   ${tally(seeded.reviews)} review(s)`)
    log(
      `  Photos:    ${tally(seeded.photos)} photo(s), written under ` +
        `${path.relative(dataDir, media.dir) || media.dir}.`,
    )
    log(
      `  Engine:    run over ${run.windowDays} day(s) ending ${run.windowEnd}: ` +
        `${run.gapsWritten} finding(s), ${run.gapsSuppressed} suppressed by the ` +
        `k-anonymity floor, ${opportunities.length} opportunit(ies).`,
    )
    log(
      `  Coverage:  Entebbe ${coverage.entebbe} published, Mukono ${coverage.mukono}, ` +
        `Kampala ${coverage.kampala}.`,
    )

    if (opportunities.length > 0) {
      log('')
      log('  Opportunities, highest severity first:')
      for (const row of opportunities.slice(0, 8)) {
        log(
          `    ${row.severity.padEnd(8)} ${row.keyword.padEnd(24)} ` +
            `${row.locationName ?? 'nationwide'}  ${row.estimatedMonthlySearches} searches`,
        )
      }
      if (opportunities.length > 8) {
        log(`    ...and ${opportunities.length - 8} more.`)
      }
    }

    if (admin) {
      log('')
      log(`  Sign in as ${admin.email} with password: ${admin.password}`)
      log('  It is the only account in the demonstration, and the password is not stored anywhere.')
    }
  } finally {
    app.close()
  }
}

try {
  main()
} catch (error) {
  if (error instanceof GuardError) {
    process.stderr.write(`${error.message}\n`)
    if (error.detail) process.stderr.write(`${error.detail}\n`)
  } else {
    process.stderr.write(`Building the demonstration failed: ${error.message}\n`)
  }
  process.exitCode = 1
}
