#!/usr/bin/env node
/**
 * The scheduled harvest, as a command.
 *
 * Runs every plan that has declared a cadence and is due, archives each live run
 * so it can be replayed offline, and reports what changed since the plan last
 * ran. The work itself is described in src/harvest/schedule.js; this file is the
 * clock, the argument parsing and the report.
 *
 * Nothing runs by default: a plan with no `cadenceDays` is manual and is left
 * alone, and on a fresh install no shipped plan declares one. Point a timer at
 * this command once the plans that should be re-read say so.
 *
 * Usage:
 *   npm run harvest:schedule                 harvest every due plan
 *   npm run harvest:schedule -- --dry-run    list what is due, harvest nothing
 *   npm run harvest:schedule -- --all        harvest every scheduled plan now
 *   npm run harvest:schedule -- --from-dir /path/to/mirror   replay offline
 */

import process from 'node:process'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { runScheduledHarvests } from '../src/harvest/schedule.js'

const USAGE = `Usage: npm run harvest:schedule -- [options]

Options:
  --dry-run            Report which plans are due. Harvest nothing, write nothing.
  --all                Harvest every scheduled plan, ignoring whether it is due.
  --plans-dir <dir>    The directory of plan files (default: the configured plans dir).
  --archive-dir <dir>  Where a live run's pages are archived (default: the configured
                       archive dir). Ignored with --from-dir, which reads a mirror.
  --from-dir <dir>     Read saved pages from a local mirror instead of live. Applies
                       to every plan, so use it only when the plans share a mirror
                       root; otherwise replay plans one at a time with harvest.js.
  --out-dir <dir>      Where to write the batch CSV + manifest.
  --quiet              Only print the final summary.
  --help               Show this message.
`

function parseArgs(argv) {
  const options = {
    dryRun: false,
    all: false,
    plansDir: null,
    archiveDir: null,
    fromDir: null,
    outDir: './harvest-batches',
    quiet: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--all') options.all = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--plans-dir') options.plansDir = argv[++i] ?? null
    else if (arg === '--archive-dir') options.archiveDir = argv[++i] ?? null
    else if (arg === '--from-dir') options.fromDir = argv[++i] ?? null
    else if (arg === '--out-dir') options.outDir = argv[++i] ?? options.outDir
    else throw new Error(`Unknown option ${arg}.\n\n${USAGE}`)
  }
  return options
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}

if (options.help) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const config = loadConfig()
const app = openApp({ config })

const log = (message) => {
  if (!options.quiet) process.stdout.write(`${message}\n`)
}

async function main() {
  try {
    const report = await runScheduledHarvests(app, {
      plansDir: options.plansDir ?? config.harvest.plansDir,
      dryRun: options.dryRun,
      all: options.all,
      fromDir: options.fromDir,
      // Archiving is a live concern. With --from-dir the run is already reading a
      // mirror, so the archive root is passed as null and nothing is re-archived.
      archiveRoot: options.fromDir
        ? null
        : options.archiveDir ?? config.harvest.archiveDir,
      batchDir: options.outDir,
    })

    for (const result of report.results) describe(result)

    log('')
    log(summaryLine(report))

    if (report.failed > 0 || report.invalid > 0) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`Scheduled harvest failed: ${error.message}\n`)
    process.exitCode = 1
  } finally {
    app.close()
  }
}

function describe(result) {
  const name = result.file
  if (result.status === 'manual') {
    log(`  manual    ${name}  (no cadence; left for an operator)`)
  } else if (result.status === 'invalid') {
    log(`  invalid   ${name}  ${result.error}`)
  } else if (result.status === 'skipped') {
    log(`  next      ${name}  not due${result.lastRunAt ? `, last run ${result.lastRunAt}` : ''}`)
  } else if (result.status === 'due') {
    log(`  due       ${name}  every ${result.cadenceDays}d${dueNote(result)}`)
  } else if (result.status === 'failed') {
    log(`  failed    ${name}  ${result.error}`)
  } else {
    log(`  harvested ${name}`)
    const summary = result.summary
    if (summary) {
      log(
        `            ${summary.total} row(s): ${summary.created} created, ` +
          `${summary.skipped} skipped, ${summary.failed} failed.`,
      )
    }
    if (result.diff) describeDiff(result.diff)
    if (result.reconciliation && result.reconciliation.staleCount > 0) {
      log(
        `            ${result.reconciliation.staleCount} reference(s) this source ` +
          'described before were not in this run (report only; nothing unpublished).',
      )
    }
    if (result.archiveRoot) log(`            pages archived: ${result.archiveRoot}`)
  }
}

function dueNote(result) {
  if (result.firstRun) return ' (never harvested)'
  return result.lastRunAt ? `, last run ${result.lastRunAt}` : ''
}

/**
 * The change since the plan last ran, in one line, with the actual references
 * when there are any. A count alone invites the question the diff was meant to
 * answer, so the first few are named.
 */
function describeDiff(diff) {
  if (diff.firstRun) {
    log(`            first completed run: ${diff.currentCount} reference(s).`)
    return
  }
  log(
    `            diff vs previous run: +${diff.added.length} added, ` +
      `-${diff.removed.length} removed, ${diff.unchanged} unchanged.`,
  )
  for (const ref of diff.added.slice(0, 10)) log(`              + ${ref}`)
  if (diff.added.length > 10) log(`              + ... and ${diff.added.length - 10} more`)
  for (const ref of diff.removed.slice(0, 10)) log(`              - ${ref}`)
  if (diff.removed.length > 10) log(`              - ... and ${diff.removed.length - 10} more`)
}

function summaryLine(report) {
  const { discovered, scheduled } = report
  if (report.dryRun) {
    const noun = report.due === 1 ? 'plan is' : 'plans are'
    return `Dry run: ${discovered} plan(s) discovered, ${report.due} ${noun} due. Nothing was harvested.`
  }
  const parts = [`${report.harvested} harvested`]
  if (report.failed) parts.push(`${report.failed} failed`)
  if (report.invalid) parts.push(`${report.invalid} invalid`)
  parts.push(`${report.skipped} not due`)
  return `${discovered} plan(s) discovered, ${scheduled} scheduled: ${parts.join(', ')}.`
}

main()
