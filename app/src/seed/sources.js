/**
 * Harvest sources that the shipped plans reference.
 *
 * These are registered idempotently at boot (seedSources) so the scheduled
 * harvest can run without a one-off manual step. They are also available to
 * the repair script `scripts/add-sources.mjs`, which continues to exist for
 * installations that were created before this boot seed.
 */
export const HARVEST_SOURCES = Object.freeze([
  {
    key: 'kampalabiz-space',
    name: 'KampalaBiz.Space client sites',
    type: 'web',
    trustLevel: 'unverified',
    owner: 'Local website mirror (C:\\Users\\HP\\Downloads\\kampalabiz.space)',
    uri: 'https://kampalabiz.space',
    licence: 'First-party website content',
    notes:
      "Contact details transcribed from each business's own published website " +
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
])

/**
 * Registers the harvest sources idempotently.
 *
 * createSource returns an existing source if one is already registered under the
 * same key, so this is safe to run on every boot.
 *
 * @param {object} app the open database handle and repositories
 * @returns {{ registered: number }} how many sources were created this run
 */
export function seedSources(app) {
  let registered = 0
  for (const source of HARVEST_SOURCES) {
    const created = app.catalogue.createSource(source)
    if (created?.createdAt === created?.updatedAt) {
      // createSource does not distinguish between created/updated in this return;
      // the distinction is not critical here. However, the check is best-effort.
      registered += 1
    }
  }
  return { registered }
}
