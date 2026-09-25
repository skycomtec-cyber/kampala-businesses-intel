#!/usr/bin/env node
/**
 * Imports businesses from a CSV file.
 *
 *   npm run import -- businesses.csv --dry-run
 *   npm run import -- businesses.csv
 *   cat businesses.csv | npm run import -- -
 *
 * The dry run is the one to do first. It reads the same file, resolves the same
 * categories and locations and reports the same duplicates, and writes nothing,
 * so the first run of a new sheet costs nothing and tells you exactly what the
 * second run would do.
 *
 * Exit status is 1 when any row failed, so a scheduled import fails loudly
 * rather than quietly importing the 96% of a sheet that happened to be valid.
 */

import fs from 'node:fs'
import process from 'node:process'

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { importBusinessesFromCsv } from '../src/import/index.js'

const USAGE = `Usage: npm run import -- <file.csv|-> [options]

Options:
  --dry-run        Validate and report without writing anything.
  --source <id>    Recorded on every created listing (default: import:csv).
  --quiet          Only print the summary.
  --help           Show this message.

Use "-" as the file to read the CSV from stdin.`

function parseArgs(argv) {
  const options = { file: null, dryRun: false, sourceId: 'import:csv', quiet: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--source') options.sourceId = argv[++index] ?? options.sourceId
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.\n\n${USAGE}`)
    else if (options.file === null) options.file = arg
    else throw new Error(`Unexpected argument ${arg}.\n\n${USAGE}`)
  }
  if (options.file === null && !options.help) throw new Error(`A file is required.\n\n${USAGE}`)
  return options
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// A bad command line is reported as a bad command line, not as a stack trace.
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

const log = (message) => {
  if (!options.quiet) process.stdout.write(`${message}\n`)
}

const config = loadConfig()
const app = openApp({ config })

try {
  let text
  if (options.file === '-') {
    text = await readStdin()
  } else {
    try {
      text = fs.readFileSync(options.file, 'utf8')
    } catch (error) {
      throw new Error(
        error.code === 'ENOENT'
          ? `There is no file at ${options.file}.`
          : `Cannot read ${options.file}: ${error.message}`,
      )
    }
  }

  const marker = { created: 'created ', skipped: 'skipped ', failed: 'FAILED ' }
  const { summary, rows } = importBusinessesFromCsv(app, text, {
    dryRun: options.dryRun,
    sourceId: options.sourceId,
    onRow: (row) => {
      log(
        `  line ${String(row.line).padStart(4)}  ${marker[row.outcome] ?? row.outcome}` +
          `  ${row.name || '(no name)'}${row.detail ? `  -  ${row.detail}` : ''}`,
      )
    },
  })

  const verb = options.dryRun ? 'would be created' : 'created'
  log('')
  log(
    `${summary.total} row(s): ${summary.created} ${verb}, ${summary.skipped} skipped, ` +
      `${summary.failed} failed.`,
  )

  const failures = rows.filter((row) => row.outcome === 'failed')
  if (failures.length > 0) {
    log('')
    log('Rows that need fixing:')
    for (const row of failures) {
      log(`  line ${row.line}: ${row.detail}`)
    }
    if (!options.dryRun) {
      log('')
      log('Nothing was written for these rows. Fix them in the file and import it again;')
      log('the rows that succeeded will be reported as duplicates this time.')
    }
  }

  if (summary.failed > 0) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
