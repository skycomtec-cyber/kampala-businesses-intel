#!/usr/bin/env node
/**
 * Harvests a source according to a plan, writes a batch, and imports it.
 *
 *   npm run harvest -- plans/kampalabiz-space.json
 *   npm run harvest -- plans/kampalabiz-space.json --from-dir /path/to/mirror
 *   npm run harvest -- plans/kampalabiz-space.json --dry-run
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { harvest } from '../src/harvest/index.js'

const USAGE = `Usage: npm run harvest -- <plan.json> [options]

Options:
  --dry-run            Validate and report without writing anything.
  --from-dir <dir>     Read saved pages from a local mirror directory.
  --batch <ref>        A name for this batch (default YYYY-MM).
  --out-dir <dir>      Where to write the batch CSV + manifest.
  --quiet              Only print the summary.
  --help               Show this message.
`

function parseArgs(argv) {
  const options = {
    plan: null,
    dryRun: false,
    fromDir: null,
    batchRef: null,
    outDir: './harvest-batches',
    quiet: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--from-dir') options.fromDir = argv[++i] ?? null
    else if (arg === '--batch') options.batchRef = argv[++i] ?? null
    else if (arg === '--out-dir') options.outDir = argv[++i] ?? options.outDir
    else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}.\n\n${USAGE}`)
    } else if (options.plan === null) options.plan = arg
    else throw new Error(`Unexpected argument ${arg}.\n\n${USAGE}`)
  }
  if (!options.plan && !options.help) throw new Error(`A plan file is required.\n\n${USAGE}`)
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

const log = (m) => {
  if (!options.quiet) process.stdout.write(`${m}\n`)
}

const config = loadConfig()
const app = openApp({ config })

async function main() {
  try {
    const planText = fs.readFileSync(options.plan, 'utf8')
    const planRaw = JSON.parse(planText)
    planRaw.filename = path.basename(options.plan)

    const result = await harvest(app, planRaw, {
      dryRun: options.dryRun,
      fromDir: options.fromDir,
      batchRef: options.batchRef,
      outputDir: options.outDir,
    })

    if (result.dryRun) {
      log('')
      log(`Dry run: ${result.rows.length} record(s) would be extracted.`)
      for (let i = 0; i < result.rows.length; i += 1) {
        const r = result.rows[i]
        log(`  page ${i + 1}: ${r.name}  [${r.category}]  @ ${r.location}`)
      }
      log('')
      log('No database writes and no batch files were produced.')
      process.exit(0)
    }

    log('')
    log(`Batch written: ${result.files.csv}`)
    log(`Manifest:      ${result.files.manifest}`)
    log('')

    const summary = result.import.summary
    log(
      `${summary.total} row(s): ${summary.created} created, ${summary.skipped} skipped, ${summary.failed} failed.`,
    )

    if (result.import.source && result.import.run) {
      log('')
      log(`Run ${result.import.run.id} for source "${result.import.source.key}" (${result.import.run.status}).`)
      const rec = result.import.reconciliation
      if (rec && rec.staleCount > 0) {
        log('')
        log(`${rec.staleCount} reference(s) this source has described before were not in this file:`)
        for (const item of rec.stale.slice(0, 20)) {
          log(`  ${String(item.externalRef).padEnd(24)}  ${item.businessName}  [${item.verificationState}]`)
        }
        if (rec.staleCount > 20) {
          log(`  ... and ${rec.staleCount - 20} more`)
        }
        log('')
        log('This is a report, not a change: nothing was unpublished.')
      }
    }

    if (summary.failed > 0) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    if (error.details) process.stderr.write(JSON.stringify(error.details, null, 2) + '\n')
    process.exitCode = 1
  } finally {
    app.close()
  }
}

main()
