#!/usr/bin/env node
/**
 * Applies the reference dataset on its own.
 *
 * `npm run bootstrap` does this too; this script exists for the case where the
 * dataset has been revised and you want to re-apply it without touching accounts.
 *
 * Only reference data: the administrative geography and the taxonomy. No business
 * is ever seeded, because a directory that opens with invented traders is a
 * directory nobody can trust.
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData } from '../src/seed/index.js'

const quiet = process.argv.includes('--quiet')
const log = (message) => {
  if (!quiet) process.stdout.write(`${message}\n`)
}

const config = loadConfig()
const app = openApp({ config })

try {
  const result = seedReferenceData(app, { config })
  if (result.skipped) {
    log('Reference seeding is disabled (KIP_SEED_REFERENCE=false).')
  } else {
    log(
      `Reference data ready: ${result.locations} new location(s), ` +
        `${result.categories} new category(ies), ${result.skills} skill(s) checked, ` +
        `${result.links} category link(s).`,
    )
  }
} catch (error) {
  process.stderr.write(`Seeding failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
