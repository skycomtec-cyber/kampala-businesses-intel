#!/usr/bin/env node
/**
 * Applies the seed on its own.
 *
 * `npm run bootstrap` does this too; this script exists for the case where the
 * dataset has been revised and you want to re-apply it without touching accounts.
 *
 * Two different kinds of writing, kept apart on purpose:
 *
 *   - Reference data: the administrative geography and the taxonomy. Shared
 *     vocabulary, so it belongs in every install.
 *   - The catalogue demonstration: one real business, imported through a
 *     registered source, landing in the review queue.
 *
 * Nothing here is invented. There is no fictional trader with a plausible phone
 * number, because a directory that opens with invented listings is a directory
 * nobody can trust, and a real record in the queue is a thing a reviewer can
 * actually check. The demonstration record is never published by the seed.
 */

import process from 'node:process'
import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { seedReferenceData, seedCatalogue } from '../src/seed/index.js'

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

  // The one real record, imported through the catalogue. It arrives in the review
  // queue and stays there: publishing it is a person's decision, made in the
  // browser, with a reason attached to it.
  const catalogue = seedCatalogue(app, { config })
  if (catalogue.skipped) {
    log('Catalogue demonstration seeding is disabled (KIP_SEED_CATALOGUE_DEMO=false).')
  } else if (catalogue.created) {
    log('Imported Skycomtec from the "KampalaBiz Manual Import" source, awaiting review.')
  } else {
    log(`Catalogue unchanged: ${catalogue.reason ?? 'the record is already present'}.`)
  }
} catch (error) {
  process.stderr.write(`Seeding failed: ${error.message}\n`)
  process.exitCode = 1
} finally {
  app.close()
}
