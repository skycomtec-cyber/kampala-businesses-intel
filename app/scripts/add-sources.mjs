/**
 * Register the two website sources the harvest came from.
 *
 * Recorded before the import so every row the CSV creates can name where it came
 * from, rather than arriving under the generic "import:csv" key. Trust level is
 * deliberately 'unverified': a business's own website is a real published
 * artefact, but nobody has checked that the phone number still reaches the shop
 * or that the premises are where the site says, and the review queue is where
 * that question gets answered.
 *
 * Sources are now seeded on boot, so this script is mostly a backfill/repair for
 * databases created before the boot seed covered them. It remains idempotent.
 */

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'
import { HARVEST_SOURCES } from '../src/seed/sources.js'

const config = loadConfig()
const app = openApp({ config })

try {
  for (const source of HARVEST_SOURCES) {
    const created = app.catalogue.createSource(source)
    console.log(
      `${created.key.padEnd(24)} id=${created.id}  type=${created.type}  trust=${created.trustLevel}`,
    )
  }
  console.log(`\nactive sources: ${app.catalogue.allSources().filter((s) => s.isActive).length}`)
} finally {
  app.close()
}
