#!/usr/bin/env node
/**
 * Runs the gap engine once, on demand.
 *
 * `maintenance.js` already does this on every launch, so this command exists for
 * the two cases maintenance does not cover: recomputing over a longer window than
 * the default to answer a specific question, and running it in isolation to see
 * what a run produced without also rolling up demand and purging retention.
 *
 * A run is recorded either way, so the lab always shows a history rather than only
 * a result.
 *
 * Usage:
 *   node scripts/analyse.js
 *   node scripts/analyse.js --window 90          a 90-day demand window
 *   node scripts/analyse.js --limit 500          measure up to 500 phrases
 *   node scripts/analyse.js --floor high         only promote high and critical
 *   node scripts/analyse.js --top 10             print the largest gaps
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { runGapEngine } from '../src/engine/gaps.js'

function parseArgs(argv) {
  const args = { windowDays: null, limit: null, floor: null, top: 0 }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--window') {
      args.windowDays = Number.parseInt(value, 10) || null
      index += 1
    } else if (flag === '--limit') {
      args.limit = Number.parseInt(value, 10) || null
      index += 1
    } else if (flag === '--floor') {
      args.floor = value
      index += 1
    } else if (flag === '--top') {
      args.top = Math.max(0, Number.parseInt(value, 10) || 0)
      index += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const config = loadConfig()
const app = openApp({ config })

try {
  const run = runGapEngine(app, {
    windowDays: args.windowDays ?? undefined,
    limit: args.limit ?? undefined,
    opportunityFloor: args.floor ?? undefined,
  })

  process.stdout.write(
    `Run ${run.id} (${run.status}) over ${run.windowDays} day(s): ` +
      `${run.gapsWritten} gap(s) written, ${run.gapsSuppressed} suppressed, ` +
      `${run.opportunitiesWritten} opportunit(y/ies). ${run.notes}\n`,
  )

  if (args.top > 0) {
    const { items } = app.intelligence.gaps({
      runId: run.id,
      sort: 'score',
      limit: args.top,
    })
    process.stdout.write(`\nLargest gaps in this run:\n`)
    for (const gap of items) {
      process.stdout.write(
        `  ${gap.gapScore.toFixed(3)}  ${gap.severity.padEnd(8)}  ` +
          `${gap.searches.toString().padStart(5)} searches  ` +
          `${gap.supplyCount} provider(s)  ${gap.phrase}  (${gap.locationName})\n`,
      )
    }
  }
} catch (error) {
  process.stderr.write(`Gap analysis failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
