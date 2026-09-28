/**
 * Register the two website sources the harvest came from.
 *
 * Recorded before the import so every row the CSV creates can name where it came
 * from, rather than arriving under the generic "import:csv" key. Trust level is
 * deliberately 'unverified': a business's own website is a real published
 * artefact, but nobody has checked that the phone number still reaches the shop
 * or that the premises are where the site says, and the review queue is where
 * that question gets answered.
 */

import { loadConfig } from '../src/config.js'
import { openApp } from '../src/db/index.js'

const SOURCES = [
  {
    key: 'kampalabiz-space',
    name: 'KampalaBiz.Space client sites',
    type: 'web',
    trustLevel: 'unverified',
    owner: 'Local website mirror (C:\\Users\\HP\\Downloads\\kampalabiz.space)',
    uri: 'https://kampalabiz.space',
    licence: 'First-party website content',
    notes:
      'Contact details transcribed from each business\'s own published website ' +
      '(mamasfood.biz, eder-est.com, nzuri-mgtech.com, lakevictoriaview.com). ' +
      'Self-published, so every field is a claim by the business until reviewed.',
  },
  {
    key: 'emeraldestatesug-com',
    name: 'Emerald Estates Uganda',
    type: 'web',
    trustLevel: 'unverified',
    owner: 'Local website mirror (Desktop\\Backup\\AUG-2025)',
    uri: 'https://emeraldestatesug.com',
    licence: 'First-party website content',
    notes:
      'Business contact and office address transcribed from the site. The site also ' +
      'lists nine estate plot offerings; those are inventory, not businesses, and ' +
      'were deliberately not imported as listings.',
  },
]

const config = loadConfig()
const app = openApp({ config })

try {
  for (const source of SOURCES) {
    const created = app.catalogue.createSource(source)
    console.log(
      `${created.key.padEnd(24)} id=${created.id}  type=${created.type}  trust=${created.trustLevel}`,
    )
  }
  console.log(`\nactive sources: ${app.catalogue.allSources().filter((s) => s.isActive).length}`)
} finally {
  app.close()
}
